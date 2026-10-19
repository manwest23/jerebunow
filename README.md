# JerebuNow

A small web app that shows the Malaysian Air Pollutant Index (API / IPU) for the DOE monitoring station nearest to you, tells you whether it is a good time to run outside, shows MET Malaysia's 7-day forecast and an air quality map. Styled like Apple Weather, in English and Bahasa Melayu. Plain HTML, CSS and JavaScript, no build step.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure |
| `style.css` | Apple-style look: system font, frosted glass cards, sky gradient tinted by API band |
| `app.js` | Loads `data/api.json`, finds your nearest station, renders the swipeable pages and locations list |
| `i18n.js` | All text in English and Bahasa Melayu |
| `map.js` | Air quality map, loaded on first open |
| `iqair.js` | IQAir client for places outside DOE's network (official API, cached, rate-limited) |
| `config.js` | Settings: your IQAir API key |
| `worker/` | Haze alerts server (Cloudflare Worker) and its setup guide |
| `scripts/fetch-fires.mjs` | NASA FIRMS fire hotspots every 3 hours (`data/fires.json`) |
| `fx.js` | Weather effects over the haze sky: rain, thunderstorms, sun, moon and stars, clouds, haze |
| `data/api.json` | Station readings. Ships with **sample data**; replaced by the fetch script |
| `scripts/fetch-apims.mjs` | Pulls live readings from DOE APIMS plus the MET Malaysia forecast, and writes `data/api.json` with a rolling 24 h history |
| `.github/workflows/update-api.yml` | Runs the fetch script every hour on GitHub Actions |

## Why there is a fetch script

The official source is DOE's APIMS portal (https://eqms.doe.gov.my/APIMS/main). It has no documented public API and blocks browser requests from other sites (CORS), so the browser cannot call it directly. The script runs server-side, saves a JSON file next to your page, and the page reads that file.

## Run locally

Geolocation only works on `https://` or `localhost`, so don't open the file directly. Serve the folder:

```bash
npx serve .          # or: python3 -m http.server 8080
```

Open http://localhost:3000 (or :8080) and allow location access.

## Connect live DOE data

1. Open https://eqms.doe.gov.my/APIMS/main in Chrome, open DevTools → Network → Fetch/XHR, and reload.
2. Find the request that returns station readings as JSON and copy its URL.
3. Test it:
   ```bash
   APIMS_URL="https://...copied url..." DEBUG=1 node scripts/fetch-apims.mjs
   ```
   If stations don't parse, compare the printed field names with `FIELD` in the script and adjust.
4. Deploy on GitHub Pages and run the workflow once from the Actions tab. It then refreshes hourly. The script already uses the public `mapcaqm` endpoint; set an `APIMS_URL` env var only if DOE moves it.

## Running outside

The running card combines three checks and shows the worst one:

- **Air**: API 0–100 is fine (with a caution near 100 when it's rising). Above 100 the advice is to run indoors.
- **Weather**: thunderstorms in the current part of the day mean skip it (lightning). Rain means run with care.
- **Heat**: afternoons at 33°C or more suggest running early morning or after sunset.

When conditions aren't good, it suggests the next dry window from the forecast.

## Forecast

The 7-day forecast comes from MET Malaysia through the government open data API (`https://api.data.gov.my/weather/forecast`, no key needed). Each station uses a forecast location with the same name, otherwise its state. To pin a station to a specific district or town, add it to `FORECAST_OVERRIDES` in the script. DOE does not publish an API (haze) forecast, so the forecast covers weather only.

Weather right now (the line under the reading and the sky animation) comes from Open-Meteo (`api.open-meteo.com`, no key), at the phone's location rounded to about 1 km for My Location and at the station for saved places. Official MET Malaysia warnings (thunderstorms, heavy rain) come from `api.data.gov.my/weather/warning` through the alerts Worker's `/warnings` route and show on pages in the states they name.

## Worldwide air quality (IQAir)

DOE stations stay the source for Malaysia. For places DOE doesn't cover (searching any city in the world, or **My Location** when you're abroad or more than 50 km from a DOE station), JerebuNow uses IQAir's official API.

1. Create a free account at https://dashboard.iqair.com and create a **Community** API key.
2. Put it in `config.js` as `iqairKey`.

The free plan allows 5 calls per minute and 10,000 per month, shared by everyone using the site. Readings are cached for 30 minutes per place and calls are spaced automatically. IQAir reports the **US AQI**, which differs from Malaysia's API, so IQAir pages use the US categories and are labelled "US AQI · IQAir". City search uses Open-Meteo's free geocoding API. Scraping iqair.com is not allowed by its terms, so the app only uses the API.

## More features

- **Best time to run:** the next dry window after sunrise or before sunset, using MET's forecast and the reading at that hour yesterday.
- **What to do:** mask, purifier and indoor tips per level, and KPM's school closure rule (above 180, or above 150 for three days in a row, announced 8 October 2026) checked against each station's last 3 days.
- **Past 7 days:** daily highest reading, from `data/history.json`, which the hourly job keeps, with a line such as "Today is the worst since Tuesday" once there are 3 days of history.
- **Childcare:** kindergartens and childcare centres follow district or state disaster committees, so the app points people to local announcements rather than stating one rule.
- **Larger text:** text follows the iPhone's Text Size setting (up to 1.5×); the big reading and map bubbles stay fixed, as in Apple Weather.
- **Fire hotspots:** NASA FIRMS VIIRS detections from the last 24 hours, shown as flames sized by fire strength.
- **Share:** a ready-made image of the current reading for WhatsApp.
- **Haze alerts:** see `worker/README.md`.

## Map

The map uses MapLibre GL with the CARTO Dark Matter basemap (OpenStreetMap data). Its colour layer is interpolated from the DOE station readings and fades out away from stations, so it shows where readings exist rather than inventing values over open sea. The timeline replays each station's last 24 hourly readings.

Attribution for the basemap (© OpenStreetMap contributors, © CARTO) is shown in the map corner and must stay.

## API bands (DOE)

| API | Status | Colour |
| --- | --- | --- |
| 0–50 | Good (Baik) | Blue |
| 51–100 | Moderate (Sederhana) | Green |
| 101–200 | Unhealthy (Tidak Sihat) | Yellow |
| 201–300 | Very Unhealthy (Sangat Tidak Sihat) | Orange |
| 300+ | Hazardous (Berbahaya) | Red |

## Notes

- Developed by manwest.

- Readings are DOE's; this is not an official DOE product. Link back to APIMS and don't present the page as government-issued.
- DOE's internal endpoints can change without notice. If the workflow fails, re-check step 1.
- Sample station coordinates are approximate; the live feed provides exact ones.
