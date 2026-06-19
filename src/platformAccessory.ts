import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SunseekerMowerPlatform } from './platform.js';
import axios from 'axios';
import * as https from 'https';
import * as mqtt from 'mqtt';
// @ts-ignore
import fakegato from 'fakegato-history';

export class SunseekerMowerAccessory {
  private mainSwitchService: Service;
  private edgeSwitchService: Service;
  private stopButtonService: Service;
  private batteryService: Service;
  private stuckSensorService: Service;
  private batteryGraphService: Service;
  
  private mqttClient?: mqtt.MqttClient;
  private loggingService: any;

  constructor(
    private readonly platform: SunseekerMowerPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const device = this.accessory.context.device;
    const FakeGatoHistoryService = fakegato(this.platform.api);

    // --- SIIVOTAAN VANHAT HAAMUPALVELUT VÄLIMUISTISTA ---
    const allowedSubtypes = ['main_mow', 'edge_mow', 'stop_btn', 'stuck_sensor', 'battery_graph'];
    this.accessory.services.forEach((service) => {
      if (
        (service.UUID === this.platform.Service.Switch.UUID || 
         service.UUID === this.platform.Service.MotionSensor.UUID ||
         service.UUID === this.platform.Service.HumiditySensor.UUID) &&
        (!service.subtype || !allowedSubtypes.includes(service.subtype))
      ) {
        this.platform.log.info(`Poistetaan vanha haamupalvelu välimuistista: ${service.displayName}`);
        this.accessory.removeService(service);
      }
    });

    // 1. Alustetaan FakeGato-historia sääprofiililla
    this.loggingService = new FakeGatoHistoryService('weather', this.accessory, {
      storage: 'fs',
      filename: `homebridge-sunseeker-history_${device.deviceSn}.json`,
    });

    // 2. Laitetiedot Apple Kotiin
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Sunseeker / G-Force')
      .setCharacteristic(this.platform.Characteristic.Model, device.deviceModelName || 'Mower S-Series')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, device.deviceSn);

    // 3. Pääkytkin: LEIKKAUS
    this.mainSwitchService = this.accessory.getService('Leikkaus') || 
                             this.accessory.addService(this.platform.Service.Switch, 'Leikkaus', 'main_mow');
    this.mainSwitchService.setCharacteristic(this.platform.Characteristic.Name, 'Leikkaus');
    this.mainSwitchService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setMainSwitchState.bind(this))
      .onGet(this.getMowerState.bind(this));

    // 4. Alikytkin: REUNALEIKKUU
    this.edgeSwitchService = this.accessory.getService('Reunaleikkuu') || 
                             this.accessory.addService(this.platform.Service.Switch, 'Reunaleikkuu', 'edge_mow');
    this.edgeSwitchService.setCharacteristic(this.platform.Characteristic.Name, 'Reunaleikkuu');
    this.edgeSwitchService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setEdgeSwitchState.bind(this));

    // 5. Painike: PYSÄYTÄ
    this.stopButtonService = this.accessory.getService('Pysäytä') || 
                             this.accessory.addService(this.platform.Service.Switch, 'Pysäytä', 'stop_btn');
    this.stopButtonService.setCharacteristic(this.platform.Characteristic.Name, 'Pysäytä');
    this.stopButtonService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setStopButtonState.bind(this));

    // 6. Liiketunnistin: JUMIUTUMISEN ILMAISIN
    this.stuckSensorService = this.accessory.getService('Mower Jumissa') || 
                              this.accessory.addService(this.platform.Service.MotionSensor, 'Mower Jumissa', 'stuck_sensor');
    this.stuckSensorService.setCharacteristic(this.platform.Characteristic.Name, 'Mower Jumissa');

    // 7. AKKUPALVELU (Apple taustajärjestelmä)
    this.batteryService = this.accessory.getService(this.platform.Service.Battery) || 
                          this.accessory.addService(this.platform.Service.Battery);

    // 8. EVE-AKKUGRAAFI (Kosteusanturi akun seurantaan)
    this.batteryGraphService = this.accessory.getService('Akun varaus') ||
                               this.accessory.addService(this.platform.Service.HumiditySensor, 'Akun varaus', 'battery_graph');
    this.batteryGraphService.setCharacteristic(this.platform.Characteristic.Name, 'Akun varaus');

    // Päivitetään alkutilanne HTTP-datasta
    this.updateUI(device.workStatusCode, device.electricity || 0, device.faultStatusCode);

    // 9. KÄYNNISTETÄÄN REAALIAIKAINEN MQTT-YHTEYS PILVEEN
    this.connectMqtt();
  }

  connectMqtt() {
    const { device } = this.accessory.context;
    this.platform.log.info('Avataan reaaliaikainen MQTT-yhteys palvelimeen mqtts.sk-robot.com...');

    this.mqttClient = mqtt.connect('mqtt://mqtts.sk-robot.com', {
      username: 'app',
      password: 'h4ijwkTnyrA',
      clientId: `homebridge_${Math.random().toString(16).substr(2, 8)}`,
      keepalive: 60,
    });

    this.mqttClient.on('connect', () => {
      this.platform.log.info('Suora MQTT-yhteys pilveen muodostettu onnistuneesti!');
      const topic = `/app/${device.appUserId}/get`;
      this.mqttClient?.subscribe(topic);
    });

    this.mqttClient.on('message', (topic, message) => {
      try {
        const payload = JSON.parse(message.toString());
        if (payload.deviceSn === device.deviceSn) {
          const battery = payload.power !== undefined ? payload.power : (payload.data?.elec || device.electricity);
          const statusCode = payload.mode !== undefined ? String(payload.mode) : (payload.data?.status !== undefined ? String(payload.data.status) : device.workStatusCode);
          const faultCode = payload.errortype !== undefined ? (payload.errortype === 0 ? 'normal' : 'error') : device.faultStatusCode;

          this.platform.log.info(`Live MQTT -> Akku: ${battery}%, Tila: ${statusCode}, Virhe: ${faultCode}`);
          this.updateUI(statusCode, battery, faultCode);
        }
      } catch (err) {
        this.platform.log.error('MQTT-viestin käsittely epäonnistui');
      }
    });
  }

  updateUI(statusCode: string, battery: number, faultCode: string) {
    const isMowing = statusCode === '1';
    const isEdgeMowing = statusCode === '4';
    const isStuck = faultCode !== 'normal' || statusCode === '6';

    this.mainSwitchService.updateCharacteristic(this.platform.Characteristic.On, isMowing);
    this.edgeSwitchService.updateCharacteristic(this.platform.Characteristic.On, isEdgeMowing);
    this.stuckSensorService.updateCharacteristic(this.platform.Characteristic.MotionDetected, isStuck);
    
    this.batteryService.updateCharacteristic(this.platform.Characteristic.BatteryLevel, battery);
    this.batteryService.updateCharacteristic(
      this.platform.Characteristic.StatusLowBattery, 
      battery < 20 ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );

    this.batteryGraphService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, battery);

    // Tallennetaan arvot historianäkymään
    this.loggingService.addEntry({
      time: Math.round(new Date().getTime() / 1000),
      temp: (isMowing || isEdgeMowing) ? 1 : 0,
      humidity: battery,
      pressure: isStuck ? 1 : 0,
    });
  }

  async sendCommand(mode: number) {
    const { accessToken, baseUrl, hostHeader, device } = this.accessory.context;
    try {
      const httpsAgent = new https.Agent({ rejectUnauthorized: false });
      await axios.post(`${baseUrl}/app_mower/device/setWorkStatus`, {
        appId: device.appUserId,
        deviceSn: device.deviceSn,
        mode: mode,
      }, {
        headers: {
          'Authorization': `bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Host': hostHeader,
          'User-Agent': 'okhttp/4.8.1',
        },
        httpsAgent: httpsAgent,
      });
    } catch (error: any) {
      this.platform.log.error(`Komentovirhe: ${error.message}`);
    }
  }

  async setMainSwitchState(value: CharacteristicValue) {
    await this.sendCommand(value as boolean ? 1 : 2);
  }

  async setEdgeSwitchState(value: CharacteristicValue) {
    await this.sendCommand(value as boolean ? 4 : 0);
  }

  async setStopButtonState(value: CharacteristicValue) {
    if (value as boolean) {
      await this.sendCommand(0);
      setTimeout(() => {
        this.stopButtonService.updateCharacteristic(this.platform.Characteristic.On, false);
      }, 500);
    }
  }

  async getMowerState(): Promise<CharacteristicValue> {
    const device = this.accessory.context.device;
    return device.workStatusCode === '1' || device.workStatusCode === '4';
  }
}