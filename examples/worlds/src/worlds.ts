import { buildCarWgif } from './car.js';
import { CITY, CITY_XL, buildCityWgif } from './city.js';
import { buildGalleryWgif } from './gallery.js';
import { buildRooftopWgif } from './rooftop.js';

/** Every committed sample world, by file name (without .wgif). */
export const WORLDS: Record<string, () => Promise<Uint8Array>> = {
  gallery: buildGalleryWgif,
  rooftop: buildRooftopWgif,
  city: () => buildCityWgif(CITY),
  car: buildCarWgif,
};

/** Device-test builds that are never committed (over the Phase One world budget on purpose). */
export const EXTRA_WORLDS: Record<string, () => Promise<Uint8Array>> = {
  'city-xl': () => buildCityWgif(CITY_XL),
};
