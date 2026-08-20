/**
 * VECTOR ICONOGRAPHY SUBSYSTEM — Ticket 25
 *
 * Provides crisp, zero-dependency, scalable SVG icons across the entire Tables IDE.
 * Replaces all Unicode emojis with pro-grade vector icons adhering to 24×24 viewBox standards.
 */

export const SVG_PATHS = {
  database: `
    <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
  `,
  table: `
    <rect x="3" y="3" width="18" height="18" rx="2"></rect>
    <path d="M3 9h18"></path>
    <path d="M9 21V9"></path>
  `,
  view: `
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path>
    <circle cx="12" cy="12" r="3"></circle>
  `,
  shield: `
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
  `,
  gear: `
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
    <circle cx="12" cy="12" r="3"></circle>
  `,
  plus: `
    <line x1="12" y1="5" x2="12" y2="19"></line>
    <line x1="5" y1="12" x2="19" y2="12"></line>
  `,
  refresh: `
    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
  `,
  close: `
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  `,
  trash: `
    <polyline points="3 6 5 6 21 6"></polyline>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
  `,
  edit: `
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
  `,
  copy: `
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
  `,
  check: `
    <polyline points="20 6 9 17 4 12"></polyline>
  `,
  search: `
    <circle cx="11" cy="11" r="8"></circle>
    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
  `,
  preview: `
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
    <circle cx="12" cy="12" r="3"></circle>
  `,
  terminal: `
    <polyline points="4 17 10 11 4 5"></polyline>
    <line x1="12" y1="19" x2="20" y2="19"></line>
  `,
  pin: `
    <line x1="12" y1="17" x2="12" y2="22"></line>
    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V6h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1v4.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z"></path>
  `,
  gripDots: `
    <circle cx="9" cy="6" r="1.5" fill="currentColor"></circle>
    <circle cx="15" cy="6" r="1.5" fill="currentColor"></circle>
    <circle cx="9" cy="12" r="1.5" fill="currentColor"></circle>
    <circle cx="15" cy="12" r="1.5" fill="currentColor"></circle>
    <circle cx="9" cy="18" r="1.5" fill="currentColor"></circle>
    <circle cx="15" cy="18" r="1.5" fill="currentColor"></circle>
  `,
  undo: `
    <path d="M3 7v6h6"></path>
    <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path>
  `,
  send: `
    <line x1="12" y1="19" x2="12" y2="5"></line>
    <polyline points="5 12 12 5 19 12"></polyline>
  `,
  stop: `
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"></rect>
  `,
  bolt: `
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor"></polygon>
  `,
  lock: `
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
  `,
  sparkles: `
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"></path>
  `,
  upload: `
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
    <polyline points="17 8 12 3 7 8"></polyline>
    <line x1="12" y1="3" x2="12" y2="15"></line>
  `,
  download: `
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
    <polyline points="7 10 12 15 17 10"></polyline>
    <line x1="12" y1="15" x2="12" y2="3"></line>
  `,
  package: `
    <path d="m16.5 9.4-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
    <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
    <line x1="12" y1="22.08" x2="12" y2="12"></line>
  `,
  messageSquare: `
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
  `,
  dashboard: `
    <rect x="3" y="3" width="7" height="9" rx="1.5"></rect>
    <rect x="14" y="3" width="7" height="5" rx="1.5"></rect>
    <rect x="14" y="12" width="7" height="9" rx="1.5"></rect>
    <rect x="3" y="16" width="7" height="5" rx="1.5"></rect>
  `,
  chevronDown: `
    <polyline points="6 9 12 15 18 9"></polyline>
  `,
  chevronRight: `
    <polyline points="9 18 15 12 9 6"></polyline>
  `,
  chevronLeft: `
    <polyline points="15 18 9 12 15 6"></polyline>
  `,
  expand: `
    <polyline points="15 3 21 3 21 9"></polyline>
    <polyline points="9 21 3 21 3 15"></polyline>
    <line x1="21" y1="3" x2="14" y2="10"></line>
    <line x1="3" y1="21" x2="10" y2="14"></line>
  `,
  key: `
    <path d="m21 2-2 2m-1.5 1.5L14 9l-2-2-4 4-2-2-4 4 1.5 1.5L5 16l4-4 2 2 3.5-3.5"></path>
    <circle cx="7.5" cy="15.5" r="5.5"></circle>
  `,
  link: `
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
  `,
  alertTriangle: `
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path>
    <line x1="12" y1="9" x2="12" y2="13"></line>
    <line x1="12" y1="17" x2="12.01" y2="17"></line>
  `,
  externalLink: `
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
    <polyline points="15 3 21 3 21 9"></polyline>
    <line x1="10" y1="14" x2="21" y2="3"></line>
  `,
  fileSpreadsheet: `
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path>
    <path d="M14 2v4a2 2 0 0 0 2 2h4"></path>
    <path d="M8 13h2"></path>
    <path d="M14 13h2"></path>
    <path d="M8 17h2"></path>
    <path d="M14 17h2"></path>
  `,
  panelLeft: `
    <rect width="18" height="18" x="3" y="3" rx="2"></rect>
    <path d="M9 3v18"></path>
  `,
  panelRight: `
    <rect width="18" height="18" x="3" y="3" rx="2"></rect>
    <path d="M15 3v18"></path>
  `,
};

/**
 * Generate an SVG icon string with customizable size, class, and stroke.
 */
export function icon(name, { size = 16, className = '', strokeWidth = 2, fill = 'none', extraAttrs = '' } = {}) {
  const path = SVG_PATHS[name] || SVG_PATHS.table;
  const cls = className ? `class="icon icon-${name} ${className}"` : `class="icon icon-${name}"`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" ${cls} ${extraAttrs}>${path}</svg>`;
}

/**
 * Convenience helper constants for direct template injection.
 */
export const ICONS = Object.keys(SVG_PATHS).reduce((acc, key) => {
  acc[key] = (options = {}) => icon(key, options);
  return acc;
}, {});
