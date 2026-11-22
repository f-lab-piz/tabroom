export const remoteOrigin = '';
export const localOrigin = 'http://127.0.0.1:18840';
export const portalOrigin = remoteOrigin || localOrigin;

export function isPortalOrigin(origin) {
  return origin === localOrigin || origin === remoteOrigin;
}
