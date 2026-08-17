const DEFAULTS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "/usr/bin/google-chrome",
  win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
};

export function resolveChromePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.BFA_CHROME_PATH?.trim();
  if (override) return override;
  const def = DEFAULTS[platform];
  if (def) return def;
  throw new Error(
    `Cannot locate Chrome on platform "${platform}". Set BFA_CHROME_PATH to your Chrome executable.`,
  );
}
