import { API } from 'homebridge';
import { PLATFORM_NAME } from './settings.js';
import { SunseekerMowerPlatform } from './platform.js';

/**
 * Tämä metodi rekisteröi pluginin Homebridgelle
 */
export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, SunseekerMowerPlatform);
};