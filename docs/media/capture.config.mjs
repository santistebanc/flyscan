// Showcase capture for flyscan: the web UI served by the backend, offline, from a stored search.
//
// The UI only reads the local SQLite store here; nothing contacts a flight site.
// Serve it first (FLYSCAN_DATA_DIR = a folder with a flights.db that holds a BER -> LON search for FORM.start):
//   npm run build --prefix backend && npm run build --prefix desktop
//   FLYSCAN_OFFLINE=1 FLYSCAN_DATA_DIR=<folder> npm run flyscan -- serve
// then: node <project-showcase>/scripts/capture.mjs --config docs/media/capture.config.mjs
// Never press Fetch in a flow: that asks the live sources.

const FORM = { origin: 'BER', destination: 'LON', start: '2026-11-13', end: '2026-11-13', ret: '', ret_end: '',
  adults: 1, children: 0, infants: 0, cabin: 'economy', currency: 'EUR' };


export default {
  name: 'flyscan',
  url: 'http://127.0.0.1:5000',
  themes: ['dark'],
  theme: {
    setup: async (context) => {
      await context.addInitScript((form) => localStorage.setItem('flyscan:form', JSON.stringify(form)), FORM);
    },
  },
  // flyscan is a desktop app (Tauri); the web build uses the same layout.
  viewports: { desktop: { width: 1440, height: 900 } },
  ready: (page) => page.getByText(/\d+ flights/).first().waitFor({ timeout: 20000 }),
  shots: [
    { id: 'results', path: '/', hero: true,
      caption: 'One list of flights from every source, each on a timeline with its price and duration' },
    {
      id: 'flight-detail', path: '/',
      caption: 'A selected flight with its legs and every booking option, seller by seller',
      before: async (page, h) => {
        await page.getByText('€71', { exact: true }).first().click();
        await page.getByText(/booking options/i).first().click();
        await h.pause(800);
      },
    },
    {
      id: 'filters', path: '/',
      caption: 'Filter by stops, price, duration, layovers and times',
      before: async (page, h) => { await page.getByRole('button', { name: 'Stops', exact: true }).click(); await h.pause(600); },
    },
  ],
  flows: [
    {
      id: 'compare-sellers', path: '/', viewport: 'desktop', theme: 'dark',
      caption: 'Sort by cheapest, open a flight and compare what each seller charges for it',
      run: async (page, h) => {
        await h.pause(600);
        await h.click(page.getByRole('button', { name: /^cheapest$/i }));
        await h.pause(900);
        await h.click(page.getByText('€71', { exact: true }).first());
        await h.pause(700);
        await h.click(page.getByText(/booking options/i).first());
        await h.pause(2200);
        await h.click(page.getByText('€73', { exact: true }).first());
        await h.pause(2000);
      },
    },
    {
      id: 'filter-direct', path: '/', viewport: 'desktop', theme: 'dark',
      caption: 'Keep only direct flights and sort them by duration',
      run: async (page, h) => {
        await h.pause(500);
        await h.click(page.getByRole('button', { name: 'Stops', exact: true }));
        await h.pause(900);
        await h.click(page.getByText('Nonstop only', { exact: true }));
        await h.pause(700);
        await page.keyboard.press('Escape');
        await h.click(page.getByRole('button', { name: /^shortest$/i }));
        await h.pause(1800);
      },
    },
  ],
};
