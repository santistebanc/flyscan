export function pythonArchitecture(platform, machine) {
  const target = platform.includes("universal2") ? machine : platform;
  if (/(?:^|[-_])(?:arm64|aarch64)(?:$|[-_])/i.test(target)) return "arm64";
  if (/(?:^|[-_])(?:amd64|x86_64)(?:$|[-_])/i.test(target)) return "x64";
  throw new Error(`Unsupported Python architecture: ${platform} (${machine})`);
}
