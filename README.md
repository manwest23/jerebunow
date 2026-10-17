# JerebuNow

A small web app that shows the Malaysian Air Pollutant Index (API / IPU) for the DOE monitoring station nearest to you, tells you whether it is a good time to run outside, and shows MET Malaysia's 7-day forecast. Styled like an iOS app. Plain HTML, CSS and JavaScript, no build step.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure |
| `style.css` | Apple-style look: system font, frosted glass cards, sky gradient tinted by API band |
| `app.js` | Loads `data/api.json`, finds your nearest station with the Geolocation API, renders everything |
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
4. Deploy on GitHub Pages: push the repo, add the URL as a repository secret named `APIMS_URL`, enable Pages, and run the workflow once from the Actions tab. It then refreshes hourly.

## Running outside

The running card combines three checks and shows the worst one:

- **Air**: API 0–100 is fine (with a caution near 100 when it's rising). Above 100 the advice is to run indoors.
- **Weather**: thunderstorms in the current part of the day mean skip it (lightning). Rain means run with care.
- **Heat**: afternoons at 33°C or more suggest running early morning or after sunset.

When conditions aren't good, it suggests the next dry window from the forecast.

## Forecast

The 7-day forecast comes from MET Malaysia through the government open data API (`https://api.data.gov.my/weather/forecast`, no key needed). Each station uses a forecast location with the same name, otherwise its state. To pin a station to a specific district or town, add it to `FORECAST_OVERRIDES` in the script. DOE does not publish an API (haze) forecast, so the forecast covers weather only.

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
