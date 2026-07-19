/**
 * The 16 host venues of the FIFA World Cup 2026 (USA / Canada / Mexico).
 *
 * Capacities are the published stadium capacities and are used only to scale
 * crowd-density guidance, never as an authoritative safety figure. The list is
 * a frozen constant rather than a database read: it is small, it never changes
 * mid-tournament, and keeping it in-module removes an I/O hop from every
 * request (see "Efficiency" in the README).
 */

export interface Venue {
  readonly id: string;
  readonly city: string;
  readonly country: 'USA' | 'Canada' | 'Mexico';
  readonly stadium: string;
  readonly capacity: number;
  /** IANA timezone, used to render local incident timestamps for staff. */
  readonly timezone: string;
}

export const VENUES: readonly Venue[] = Object.freeze([
  { id: 'atl', city: 'Atlanta', country: 'USA', stadium: 'Mercedes-Benz Stadium', capacity: 71000, timezone: 'America/New_York' },
  { id: 'bos', city: 'Boston', country: 'USA', stadium: 'Gillette Stadium', capacity: 65878, timezone: 'America/New_York' },
  { id: 'dal', city: 'Dallas', country: 'USA', stadium: 'AT&T Stadium', capacity: 80000, timezone: 'America/Chicago' },
  { id: 'gdl', city: 'Guadalajara', country: 'Mexico', stadium: 'Estadio Akron', capacity: 48071, timezone: 'America/Mexico_City' },
  { id: 'hou', city: 'Houston', country: 'USA', stadium: 'NRG Stadium', capacity: 72220, timezone: 'America/Chicago' },
  { id: 'kan', city: 'Kansas City', country: 'USA', stadium: 'Arrowhead Stadium', capacity: 76416, timezone: 'America/Chicago' },
  { id: 'lax', city: 'Los Angeles', country: 'USA', stadium: 'SoFi Stadium', capacity: 70240, timezone: 'America/Los_Angeles' },
  { id: 'mex', city: 'Mexico City', country: 'Mexico', stadium: 'Estadio Azteca', capacity: 87523, timezone: 'America/Mexico_City' },
  { id: 'mia', city: 'Miami', country: 'USA', stadium: 'Hard Rock Stadium', capacity: 65326, timezone: 'America/New_York' },
  { id: 'mty', city: 'Monterrey', country: 'Mexico', stadium: 'Estadio BBVA', capacity: 53500, timezone: 'America/Monterrey' },
  { id: 'nyn', city: 'New York / New Jersey', country: 'USA', stadium: 'MetLife Stadium', capacity: 82500, timezone: 'America/New_York' },
  { id: 'phl', city: 'Philadelphia', country: 'USA', stadium: 'Lincoln Financial Field', capacity: 69796, timezone: 'America/New_York' },
  { id: 'sfo', city: 'San Francisco Bay Area', country: 'USA', stadium: "Levi's Stadium", capacity: 68500, timezone: 'America/Los_Angeles' },
  { id: 'sea', city: 'Seattle', country: 'USA', stadium: 'Lumen Field', capacity: 69000, timezone: 'America/Los_Angeles' },
  { id: 'tor', city: 'Toronto', country: 'Canada', stadium: 'BMO Field', capacity: 45000, timezone: 'America/Toronto' },
  { id: 'van', city: 'Vancouver', country: 'Canada', stadium: 'BC Place', capacity: 54500, timezone: 'America/Vancouver' },
]);

/**
 * Index of venues by id. Built once at module scope so lookups are O(1) and
 * are not re-derived on every request (the Worker isolate is reused).
 */
const VENUE_INDEX: ReadonlyMap<string, Venue> = new Map(VENUES.map((v) => [v.id, v]));

/** Total number of host venues; 16 is a fixed property of the 2026 format. */
export const VENUE_COUNT = VENUES.length;

/** Tournament shape constants, used in the UI and in prompt grounding. */
export const TOURNAMENT = Object.freeze({
  name: 'FIFA World Cup 2026',
  teams: 48,
  matches: 104,
  hostCountries: 3,
  hostCities: VENUE_COUNT,
});

/**
 * Look up a venue by id in O(1).
 *
 * @param id Venue identifier such as `"nyn"`. Case-insensitive.
 * @returns The venue, or `null` when the id is unknown. Never throws, because
 *          this sits directly behind untrusted request input.
 */
export function findVenue(id: unknown): Venue | null {
  if (typeof id !== 'string') return null;
  return VENUE_INDEX.get(id.trim().toLowerCase()) ?? null;
}
