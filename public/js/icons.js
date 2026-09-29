// Stroke icons used across the app (24px grid, currentColor).
const P = {
  back: '<path d="m15 18-6-6 6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  plusCircle: '<circle cx="12" cy="12" r="9.5"/><path d="M12 8v8M8 12h8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  chat: '<path d="M20.5 11.5a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1.4-4.6A8.5 8.5 0 1 1 20.5 11.5Z"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  phoneOff: '<path transform="rotate(135 12 12)" d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  video: '<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="m21.5 8-6 4 6 4Z"/>',
  videoOff: '<path d="M3 3l18 18"/><path d="M15.5 10.5 21.5 7v10l-2-1.2M10.5 6h2.5a2.5 2.5 0 0 1 2.5 2.5V13M15.5 16v.5A2.5 2.5 0 0 1 13 19H5a2.5 2.5 0 0 1-2.5-2.5v-8A2.5 2.5 0 0 1 5 6h1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4.5M12 8h.01"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/>',
  flip: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><path d="M9 13a3 3 0 0 1 5.5-1.6M15 13a3 3 0 0 1-5.5 1.6"/><path d="M14.5 9.5v2h-2M9.5 16.5v-2h2"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  micOff: '<path d="M3 3l18 18"/><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3"/><path d="M19 11a7 7 0 0 1-1.2 3.9M5 11a7 7 0 0 0 11.1 5.7M12 18v3"/>',
  send: '<path d="M21.5 2.5 11 13"/><path d="M21.5 2.5 15 21.5l-4-8.5-8.5-4Z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12.5A2 2 0 0 0 8.5 21h7a2 2 0 0 0 2-1.5L18.5 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>',
  reply: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5s1.3 1.8 3.5 1.8 3.5-1.8 3.5-1.8M9 9.5h.01M15 9.5h.01"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  bellOff: '<path d="M8.7 3.9A6 6 0 0 1 18 8c0 3.4.7 5.6 1.5 7M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h13M10.3 21a1.9 1.9 0 0 0 3.4 0M3 3l18 18"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  userPlus: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6"/>',
  screen: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4M9 11l3-3 3 3M12 8v5"/>',
  minimize: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  inArrow: '<path d="M17 7 7 17M16 17H7V8"/>',
  outArrow: '<path d="M7 17 17 7M8 7h9v9"/>',
  check: '<path d="m4.5 12.5 5 5L20 7"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  // Reactions
  heart: '<path d="M12 20s-7.5-4.6-9.2-9.3C1.6 7.3 3.8 4 7.2 4c2 0 3.6 1.1 4.8 2.8C13.2 5.1 14.8 4 16.8 4c3.4 0 5.6 3.3 4.4 6.7C19.5 15.4 12 20 12 20Z"/>',
  like: '<path d="M7 10v11M7 10l4-7a2.5 2.5 0 0 1 3 3l-1 4h5.5a2 2 0 0 1 2 2.4l-1.4 7A2 2 0 0 1 17.1 21H7M3 10h4v11H3Z"/>',
  laugh: '<circle cx="12" cy="12" r="9"/><path d="M7.5 13h9a4.5 4.5 0 0 1-9 0Z"/><path d="m8 9.5 2 .8M16 9.5l-2 .8"/>',
  wow: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="15.5" r="2"/><path d="M9 9.5h.01M15 9.5h.01"/>',
  sad: '<circle cx="12" cy="12" r="9"/><path d="M8.5 16.5s1.3-1.8 3.5-1.8 3.5 1.8 3.5 1.8M9 9.5h.01M15 9.5h.01"/>',
  angry: '<circle cx="12" cy="12" r="9"/><path d="M8.5 16.5s1.3-1.8 3.5-1.8 3.5 1.8 3.5 1.8M8 8.5l2.5 1.5M16 8.5l-2.5 1.5"/>',
};

export const REACTIONS = [
  { key: 'heart', label: 'Love' },
  { key: 'like', label: 'Like' },
  { key: 'laugh', label: 'Haha' },
  { key: 'wow', label: 'Wow' },
  { key: 'sad', label: 'Sad' },
  { key: 'angry', label: 'Angry' },
];

export function ic(name, size = 22, extra = '') {
  return `<svg class="i${extra ? ' ' + extra : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
}

export const PLAY = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5v17L20.5 12Z" fill="currentColor"/></svg>';
export const PAUSE = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="5" height="16" rx="1.5" fill="currentColor"/><rect x="14" y="4" width="5" height="16" rx="1.5" fill="currentColor"/></svg>';
export const LOGO = '<svg class="logo" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="var(--logo-bg)"/><path d="M10 23V9.5h6.5a4.5 4.5 0 0 1 0 9H13.5" fill="none" stroke="var(--logo-fg)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="23.5" cy="23.5" r="3" fill="#C4430F"/></svg>';
