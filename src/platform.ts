import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { SunseekerMowerAccessory } from './platformAccessory.js';
import axios from 'axios';
import * as https from 'https';

const BASE_URL = 'https://server.sk-robot.com/api';
const HOST_HEADER = 'server.sk-robot.com';

export class SunseekerMowerPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    this.log.debug('Sunseeker Lawnmower plugin alustettu. Odotetaan Homebridgen käynnistymistä...');

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices().catch(error => {
        this.log.error(`Sunseeker discovery epäonnistui: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  async discoverDevices(): Promise<void> {
    const email = String(this.config.email ?? '');
    const password = String(this.config.password ?? '');

    if (!email || !password) {
      this.log.error('Sähköposti tai salasana puuttuu asetuksista!');
      return;
    }

    const httpsAgent = new https.Agent({ rejectUnauthorized: false });

    const formData = new URLSearchParams();
    formData.append('username', email);
    formData.append('password', password);
    formData.append('grant_type', 'password');
    formData.append('scope', 'server');

    this.log.info('Kirjaudutaan Robotic Mower Connect / sk-robot -pilveen...');

    const loginResponse = await axios.post(`${BASE_URL}/auth/oauth/token`, formData, {
      headers: {
        'Authorization': 'Basic YXBwOmFwcA==',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'okhttp/4.8.1',
        'Host': HOST_HEADER,
        'Connection': 'Keep-Alive',
      },
      httpsAgent,
    });

    const accessToken = loginResponse.data?.access_token;

    if (!accessToken) {
      throw new Error(`Kirjautuminen ei palauttanut access_tokenia: ${JSON.stringify(loginResponse.data)}`);
    }

    this.log.info('Kirjautuminen onnistui. Haetaan leikkurit...');

    const deviceResponse = await axios.get(`${BASE_URL}/mower/device-user/list`, {
      headers: {
        'Authorization': `bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept-Language': 'fi',
        'Host': HOST_HEADER,
        'User-Agent': 'okhttp/4.4.1',
      },
      httpsAgent,
    });

    const devices = Array.isArray(deviceResponse.data?.data) ? deviceResponse.data.data : [];

    if (devices.length === 0) {
      this.log.warn(`Pilvi ei palauttanut yhtään leikkuria. Raw response: ${JSON.stringify(deviceResponse.data)}`);
      return;
    }

    const discoveredUUIDs: string[] = [];

    for (const device of devices) {
      const deviceSn = String(device.deviceSn ?? device.sn ?? '');

      if (!deviceSn) {
        this.log.warn(`Ohitetaan laite, koska deviceSn puuttuu: ${JSON.stringify(device)}`);
        continue;
      }

      const uuid = this.api.hap.uuid.generate(deviceSn);
      discoveredUUIDs.push(uuid);

      const displayName = String(device.deviceName ?? device.name ?? device.modelName ?? 'Sunseeker Mower');
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      if (existingAccessory) {
        this.log.info(`Päivitetään leikkuri välimuistista: ${displayName}`);
        existingAccessory.context.device = device;
        existingAccessory.context.accessToken = accessToken;
        existingAccessory.context.baseUrl = BASE_URL;
        existingAccessory.context.hostHeader = HOST_HEADER;

        new SunseekerMowerAccessory(this, existingAccessory);
      } else {
        this.log.info(`Luodaan uusi HomeKit-laite leikkurille: ${displayName}`);
        const accessory = new this.api.platformAccessory(displayName, uuid);
        accessory.context.device = device;
        accessory.context.accessToken = accessToken;
        accessory.context.baseUrl = BASE_URL;
        accessory.context.hostHeader = HOST_HEADER;

        new SunseekerMowerAccessory(this, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    for (const accessory of this.accessories) {
      if (!discoveredUUIDs.includes(accessory.UUID)) {
        this.log.info(`Poistetaan välimuistista kadonnut leikkuri: ${accessory.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Ladattiin accessory välimuistista: ${accessory.displayName}`);
    this.accessories.push(accessory);
  }
}