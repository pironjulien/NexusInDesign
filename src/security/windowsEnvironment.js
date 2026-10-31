const ALLOWED_KEYS = [
  'SystemRoot',
  'WINDIR',
  'PATH',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'PSModulePath',
];

export function minimalWindowsEnvironment(extra = {}, source = process.env) {
  const output = {};
  const sourceKeys = Object.keys(source);
  for (const wanted of ALLOWED_KEYS) {
    const actual = sourceKeys.find((key) => key.toLowerCase() === wanted.toLowerCase());
    if (actual && source[actual] !== undefined) output[actual] = source[actual];
  }
  return { ...output, ...extra };
}
