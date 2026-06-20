import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import axios from 'axios';
import * as https from 'https';
import { SunseekerMowerPlatform } from './platform.js';
// @ts-ignore fakegato-history does not ship TypeScript types
import fakegato from 'fakegato-history';

type NormalizedMowerState = {
  battery: number;
  isMowing: boolean;
  isCharging: boolean;
  isOnline: boolean;
  hasFault: boolean;
  rawStatus: string;
  rawFault: string;
};

type LanguageCode = 'fi' | 'en';

type TranslationSet = {
  manufacturer: string;
  defaultModel: string;
  serviceMower: string;
  serviceHome: string;
  serviceMowing: string;
  serviceCharging: string;
  serviceOnline: string;
  serviceFault: string;
  removeOldService: string;
  historyInitFailed: string;
  firstUpdateFailed: string;
  updateFailed: string;
  missingDeviceSnContext: string;
  missingDeviceSnCommand: string;
  missingAppId: string;
  updateUi: string;
  historyEntryFailed: string;
  commandResponse: string;
  commandError: string;
};

const TRANSLATIONS: Record<LanguageCode, TranslationSet> = {
  fi: {
    manufacturer: 'Sunseeker / Brucke',
    defaultModel: 'RM501',
    serviceMower: 'Leikkaus',
    serviceHome: 'Kotiin',
    serviceMowing: 'Leikkaa',
    serviceCharging: 'Latauksessa',
    serviceOnline: 'Online',
    serviceFault: 'Virhe',
    removeOldService: 'Poistetaan vanha haamupalvelu välimuistista',
    historyInitFailed: 'Eve-historian alustus epäonnistui',
    firstUpdateFailed: 'Ensimmäinen tilapäivitys epäonnistui',
    updateFailed: 'Tilapäivitys epäonnistui',
    missingDeviceSnContext: 'deviceSn puuttuu accessory contextista',
    missingDeviceSnCommand: 'deviceSn puuttuu, komentoa ei voida lähettää',
    missingAppId: 'appId/userId puuttuu, komentoa ei voida lähettää',
    updateUi: 'Päivitetään UI',
    historyEntryFailed: 'Eve-historiatapahtuman tallennus epäonnistui',
    commandResponse: 'Komento vastaus',
    commandError: 'Komentovirhe',
  },
  en: {
    manufacturer: 'Sunseeker / Brucke',
    defaultModel: 'RM501',
    serviceMower: 'Mowing',
    serviceHome: 'Return Home',
    serviceMowing: 'Mowing Active',
    serviceCharging: 'Charging',
    serviceOnline: 'Online',
    serviceFault: 'Fault',
    removeOldService: 'Removing old cached service',
    historyInitFailed: 'Failed to initialize Eve history',
    firstUpdateFailed: 'Initial status update failed',
    updateFailed: 'Status update failed',
    missingDeviceSnContext: 'deviceSn is missing from accessory context',
    missingDeviceSnCommand: 'deviceSn is missing, command cannot be sent',
    missingAppId: 'appId/userId is missing, command cannot be sent',
    updateUi: 'Updating UI',
    historyEntryFailed: 'Failed to save Eve history entry',
    commandResponse: 'Command response',
    commandError: 'Command error',
  },
};

function getLanguageCode(language: unknown): LanguageCode {
  const value = String(language ?? 'fi').toLowerCase();
  return value.startsWith('en') ? 'en' : 'fi';
}

export class SunseekerMowerAccessory {
  private readonly mowerSwitchService: Service;
  private readonly homeSwitchService: Service;
  private readonly batteryService: Service;
  private readonly mowingSensorService: Service;
  private readonly chargingSensorService: Service;
  private readonly onlineSensorService: Service;
  private readonly faultSensorService: Service;

  private readonly httpsAgent = new https.Agent({ rejectUnauthorized: false });
  private readonly loggingService?: any;
  private pollTimer?: NodeJS.Timeout;
  private lastState: NormalizedMowerState;
  private lastHistoryValue?: number;
  private readonly language: LanguageCode;
  private readonly text: TranslationSet;

  constructor(
    private readonly platform: SunseekerMowerPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const device = this.accessory.context.device;

    this.language = getLanguageCode(this.platform.config.language);
    this.text = TRANSLATIONS[this.language];

    this.cleanupOldServices();

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, this.text.manufacturer)
      .setCharacteristic(this.platform.Characteristic.Model, String(device.deviceModelName ?? device.modelName ?? this.text.defaultModel))
      .setCharacteristic(this.platform.Characteristic.SerialNumber, String(device.deviceSn ?? device.sn ?? 'unknown'));

    this.mowerSwitchService = this.accessory.getServiceById(this.platform.Service.Switch, 'main_mow') ||
      this.accessory.addService(this.platform.Service.Switch, this.text.serviceMower, 'main_mow');
    this.mowerSwitchService.setCharacteristic(this.platform.Characteristic.Name, this.text.serviceMower);
    this.mowerSwitchService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setMowerSwitchState.bind(this))
      .onGet(this.getMowerState.bind(this));

    this.homeSwitchService = this.accessory.getServiceById(this.platform.Service.Switch, 'return_home') ||
      this.accessory.addService(this.platform.Service.Switch, this.text.serviceHome, 'return_home');
    this.homeSwitchService.setCharacteristic(this.platform.Characteristic.Name, this.text.serviceHome);
    this.homeSwitchService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setHomeSwitchState.bind(this));

    this.batteryService = this.accessory.getService(this.platform.Service.Battery) ||
      this.accessory.addService(this.platform.Service.Battery);

    this.mowingSensorService = this.accessory.getServiceById(this.platform.Service.OccupancySensor, 'mowing_sensor') ||
      this.accessory.addService(this.platform.Service.OccupancySensor, this.text.serviceMowing, 'mowing_sensor');
    this.mowingSensorService.setCharacteristic(this.platform.Characteristic.Name, this.text.serviceMowing);

    this.chargingSensorService = this.accessory.getServiceById(this.platform.Service.ContactSensor, 'charging_sensor') ||
      this.accessory.addService(this.platform.Service.ContactSensor, this.text.serviceCharging, 'charging_sensor');
    this.chargingSensorService.setCharacteristic(this.platform.Characteristic.Name, this.text.serviceCharging);

    this.onlineSensorService = this.accessory.getServiceById(this.platform.Service.ContactSensor, 'online_sensor') ||
      this.accessory.addService(this.platform.Service.ContactSensor, this.text.serviceOnline, 'online_sensor');
    this.onlineSensorService.setCharacteristic(this.platform.Characteristic.Name, this.text.serviceOnline);

    this.faultSensorService = this.accessory.getServiceById(this.platform.Service.MotionSensor, 'fault_sensor') ||
      this.accessory.addService(this.platform.Service.MotionSensor, this.text.serviceFault, 'fault_sensor');
    this.faultSensorService.setCharacteristic(this.platform.Characteristic.Name, this.text.serviceFault);

    this.lastState = this.normalizeState(device);
    this.updateUI(this.lastState);

    if (this.platform.config.enableHistory !== false) {
      this.loggingService = this.setupHistory(String(device.deviceSn ?? device.sn ?? this.accessory.UUID));
    }

    this.startPolling();
  }

  private cleanupOldServices(): void {
    const allowedSubtypes = [
      'main_mow',
      'return_home',
      'mowing_sensor',
      'charging_sensor',
      'online_sensor',
      'fault_sensor',
    ];

    for (const service of [...this.accessory.services]) {
      if (service.UUID === this.platform.Service.AccessoryInformation.UUID || service.UUID === this.platform.Service.Battery.UUID) {
        continue;
      }

      if (!service.subtype || !allowedSubtypes.includes(service.subtype)) {
        this.platform.log.info(`${this.text.removeOldService}: ${service.displayName}`);
        this.accessory.removeService(service);
      }
    }
  }

  private setupHistory(deviceSn: string): any | undefined {
    try {
      const FakeGatoHistoryService = fakegato(this.platform.api);
      return new FakeGatoHistoryService('motion', this.accessory, {
        storage: 'fs',
        size: Number(this.platform.config.historySize ?? 4032),
        filename: `homebridge-sunseeker-mowing-history_${deviceSn}.json`,
      });
    } catch (error) {
      this.platform.log.warn(`${this.text.historyInitFailed}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private startPolling(): void {
    const pollInterval = Math.max(15, Number(this.platform.config.pollInterval ?? 60));

    this.updateFromCloud().catch(error => {
      this.platform.log.warn(`${this.text.firstUpdateFailed}: ${error instanceof Error ? error.message : String(error)}`);
    });

    this.pollTimer = setInterval(() => {
      this.updateFromCloud().catch(error => {
        this.platform.log.warn(`${this.text.updateFailed}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, pollInterval * 1000);
  }

  private async updateFromCloud(): Promise<void> {
    const { accessToken, baseUrl, hostHeader, device } = this.accessory.context;
    const deviceSn = String(device.deviceSn ?? device.sn ?? '');

    if (!deviceSn) {
      throw new Error(this.text.missingDeviceSnContext);
    }

    const response = await axios.get(`${baseUrl}/mower/device/getBysn?sn=${encodeURIComponent(deviceSn)}`, {
      headers: {
        'Authorization': `bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept-Language': this.language,
        'Host': hostHeader,
        'User-Agent': 'okhttp/4.4.1',
      },
      httpsAgent: this.httpsAgent,
    });

    this.platform.log.debug(`Raw RM501 status for ${deviceSn}: ${JSON.stringify(response.data)}`);

    const rawDevice = response.data?.data ?? response.data;
    this.accessory.context.device = {
      ...device,
      ...rawDevice,
      deviceSn,
    };

    const state = this.normalizeState(this.accessory.context.device);
    this.lastState = state;
    this.updateUI(state);
    this.addHistoryEntry(state);
  }

  private normalizeState(raw: any): NormalizedMowerState {
    const rawStatusValue = raw?.workStatusCode ?? raw?.workStatus ?? raw?.status ?? raw?.mode ?? 'unknown';
    const rawFaultValue = raw?.faultStatusCode ?? raw?.faultStatus ?? raw?.faultCode ?? raw?.errorCode ?? 'normal';
    const batteryValue = raw?.electricity ?? raw?.electricQuantity ?? raw?.battery ?? raw?.power ?? 0;
    const onlineValue = raw?.online ?? raw?.onlineFlag ?? raw?.deviceOnline ?? true;

    const rawStatus = String(rawStatusValue);
    const rawFault = String(rawFaultValue);
    const battery = this.clampBattery(Number(batteryValue));

    const isMowing = rawStatus === '1' || rawStatus.toLowerCase() === 'mowing';
    const isCharging = rawStatus === '3' || rawStatus.toLowerCase() === 'charging';
    const hasFault = (rawFault !== 'normal' && rawFault !== '0' && rawFault !== 'undefined') || rawStatus === '6';
    const isOnline = !(onlineValue === false || onlineValue === 0 || onlineValue === '0' || rawStatus.toLowerCase() === 'offline');

    return {
      battery,
      isMowing,
      isCharging,
      isOnline,
      hasFault,
      rawStatus,
      rawFault,
    };
  }

  private clampBattery(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }

    return Math.max(0, Math.min(100, Math.round(value)));
  }

  private updateUI(state: NormalizedMowerState): void {
    this.platform.log.debug(
      `${this.text.updateUi}: battery=${state.battery}, mowing=${state.isMowing}, charging=${state.isCharging}, online=${state.isOnline}, fault=${state.hasFault}, rawStatus=${state.rawStatus}, rawFault=${state.rawFault}`,
    );

    this.mowerSwitchService.updateCharacteristic(this.platform.Characteristic.On, state.isMowing);

    this.mowingSensorService.updateCharacteristic(
      this.platform.Characteristic.OccupancyDetected,
      state.isMowing
        ? this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    );

    this.chargingSensorService.updateCharacteristic(
      this.platform.Characteristic.ContactSensorState,
      state.isCharging
        ? this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED
        : this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    );

    this.onlineSensorService.updateCharacteristic(
      this.platform.Characteristic.ContactSensorState,
      state.isOnline
        ? this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED
        : this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    );

    this.faultSensorService.updateCharacteristic(
      this.platform.Characteristic.MotionDetected,
      state.hasFault,
    );

    this.batteryService.updateCharacteristic(this.platform.Characteristic.BatteryLevel, state.battery);
    this.batteryService.updateCharacteristic(
      this.platform.Characteristic.StatusLowBattery,
      state.battery < 20
        ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
  }

  private addHistoryEntry(state: NormalizedMowerState): void {
    if (!this.loggingService) {
      return;
    }

    const historyValue = state.isMowing ? 1 : 0;

    if (historyValue === this.lastHistoryValue) {
      return;
    }

    try {
      this.loggingService.addEntry({
        time: Math.round(Date.now() / 1000),
        status: historyValue,
      });
      this.lastHistoryValue = historyValue;
    } catch (error) {
      this.platform.log.debug(`${this.text.historyEntryFailed}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async sendCommand(mode: number): Promise<void> {
    const { accessToken, baseUrl, hostHeader, device } = this.accessory.context;
    const deviceSn = String(device.deviceSn ?? device.sn ?? '');
    const appId = device.appUserId ?? device.userId;

    if (!deviceSn) {
      throw new Error(this.text.missingDeviceSnCommand);
    }

    if (!appId) {
      throw new Error(this.text.missingAppId);
    }

    try {
      const response = await axios.post(`${baseUrl}/app_mower/device/setWorkStatus`, {
        appId,
        deviceSn,
        mode,
      }, {
        headers: {
          'Authorization': `bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Host': hostHeader,
          'User-Agent': 'okhttp/4.8.1',
        },
        httpsAgent: this.httpsAgent,
      });

      this.platform.log.debug(`${this.text.commandResponse} mode=${mode}: ${JSON.stringify(response.data)}`);
    } catch (error) {
      this.platform.log.error(`${this.text.commandError} mode=${mode}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private async setMowerSwitchState(value: CharacteristicValue): Promise<void> {
    const isOn = value as boolean;

    if (isOn) {
      await this.sendCommand(1);
    } else {
      const offCommand = String(this.platform.config.offCommand ?? 'pause');
      await this.sendCommand(offCommand === 'home' ? 2 : 0);
    }

    await this.updateFromCloud();
  }

  private async setHomeSwitchState(value: CharacteristicValue): Promise<void> {
    if (!(value as boolean)) {
      return;
    }

    await this.sendCommand(2);

    setTimeout(() => {
      this.homeSwitchService.updateCharacteristic(this.platform.Characteristic.On, false);
    }, 1000);

    await this.updateFromCloud();
  }

  private async getMowerState(): Promise<CharacteristicValue> {
    return this.lastState.isMowing;
  }
}