import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { SunseekerMowerAccessory } from './platformAccessory.js';
import axios from 'axios';
import * as https from 'https';

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

    this.log.debug('Plugin alustettu. Odotetaan Homebridgen käynnistymistä...');

    this.api.on('didFinishLaunching', () => {
      this.loginToCloud();
    });
  }

  async loginToCloud() {
    const email = this.config.email;
    const password = this.config.password;
    const serverType = this.config.serverType || 'old';

    if (!email || !password) {
      this.log.error('Sähköposti tai salasana puuttuu asetuksista!');
      return;
    }

    try {
      let baseUrl = '';
      let hostHeader = '';

      if (serverType === 'old') {
        baseUrl = 'https://server.sk-robot.com/api';
        hostHeader = 'server.sk-robot.com';
      } else if (serverType === 'new_eu') {
        baseUrl = 'https://wirefree-specific.sk-robot.com/api';
        hostHeader = 'wirefree-specific.sk-robot.com';
      } else if (serverType === 'new_us') {
        baseUrl = 'https://wirefree-specific-us.sk-robot.com/api';
        hostHeader = 'wirefree-specific-us.sk-robot.com';
      }

      const httpsAgent = new https.Agent({ rejectUnauthorized: false });

      const formData = new URLSearchParams();
      formData.append('username', email);
      formData.append('password', password);
      formData.append('grant_type', 'password');
      formData.append('scope', 'server');

      // 1. Kirjautuminen pilveen
      const loginResponse = await axios.post(`${baseUrl}/auth/oauth/token`, formData, {
        headers: {
          'Authorization': 'Basic YXBwOmFwcA==', 
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'okhttp/4.8.1',
          'Host': hostHeader,
          'Connection': 'Keep-Alive',
        },
        httpsAgent: httpsAgent,
      });

      const accessToken = loginResponse.data.access_token;

      // 2. Haetaan laitelista
      const listEndpoint = serverType === 'old' 
        ? '/mower/device-user/list' 
        : '/app_wireless_mower/device-user/getCustomDevice?all=true';

      const deviceResponse = await axios.get(`${baseUrl}${listEndpoint}`, {
        headers: {
          'Authorization': `bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept-Language': 'fi',
          'Host': hostHeader,
          'User-Agent': 'okhttp/4.4.1',
        },
        httpsAgent: httpsAgent,
      });

      if (deviceResponse.data && deviceResponse.data.data && deviceResponse.data.data.length > 0) {
        for (const device of deviceResponse.data.data) {
          const uuid = this.api.hap.uuid.generate(device.deviceSn);
          const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

          if (existingAccessory) {
            this.log.info(`Päivitetään leikkuri välimuistista: ${device.deviceName}`);
            existingAccessory.context.device = device;
            existingAccessory.context.accessToken = accessToken;
            existingAccessory.context.baseUrl = baseUrl;
            existingAccessory.context.hostHeader = hostHeader;
            
            new SunseekerMowerAccessory(this, existingAccessory);
          } else {
            this.log.info(`Luodaan uusi HomeKit-laite leikkurille: ${device.deviceName}`);
            const accessory = new this.api.platformAccessory(device.deviceName || 'Mower', uuid);
            accessory.context.device = device;
            accessory.context.accessToken = accessToken;
            accessory.context.baseUrl = baseUrl;
            accessory.context.hostHeader = hostHeader;

            new SunseekerMowerAccessory(this, accessory);
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          }
        }
      }

    } catch (error: any) {
      this.log.error('Pilviyhteys epäonnistui:', error.message);
    }
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.accessories.push(accessory);
  }
}