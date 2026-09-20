export default {
  testDir: ".",
  testMatch: /.*\.spec\.mjs/,
  timeout: 45_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE || "http://127.0.0.1:4100",
    headless: true,
    launchOptions: { executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" },
    trace: "off",
  },
};
