/** Reserve a window during the click, before asynchronous enrollment starts. */
export function openTailscaleAuthorization(): Window | null {
  let popup: Window | null;
  try {
    popup = window.open('about:blank', '_blank', 'popup,width=520,height=680');
  } catch {
    return null;
  }
  if (!popup) return null;
  // Keep our handle for navigation, but never give the authorization site an
  // opener that can navigate or inspect the Platform window.
  popup.opener = null;
  const doc = popup.document;
  doc.title = 'Connect Tailscale · Hatch';
  doc.documentElement.lang = 'en';
  const referrer = doc.createElement('meta');
  referrer.name = 'referrer';
  referrer.content = 'no-referrer';
  doc.head.append(referrer);
  const main = doc.createElement('main');
  main.style.cssText =
    'max-width:28rem;margin:18vh auto;padding:2rem;font:16px/1.6 system-ui,sans-serif;color:#292524;background:#fff';
  const title = doc.createElement('h1');
  title.textContent = 'Connecting to Tailscale…';
  title.style.cssText = 'font-size:1.5rem;font-weight:600;line-height:1.3';
  const message = doc.createElement('p');
  message.textContent =
    'Keep this window open. Authorization will appear here if needed. If this device is already authorized, this window will close automatically.';
  main.append(title, message);
  doc.body.replaceChildren(main);
  return popup;
}
