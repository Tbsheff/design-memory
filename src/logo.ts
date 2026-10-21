const bar = (angle: number) => `<rect x="-64" y="-9.5" width="128" height="19" rx="9.5" transform="rotate(${angle})"/>`;
const swatch = (index: number, color: string) => `<circle cx="${-177 + index * 74}" cy="140" r="25.5" fill="${color}" stroke="#fff" stroke-opacity=".9" stroke-width="5"/>`;

const cardDefs = (id: string, shadowOpacity: number) => `
<linearGradient id="${id}-card" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#eef3ec"/></linearGradient>
<linearGradient id="${id}-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6c58f"/><stop offset=".5" stop-color="#f09a7a"/><stop offset="1" stop-color="#d9737a"/></linearGradient>
<radialGradient id="${id}-sun" cx="82" cy="-150" r="120" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff4dc" stop-opacity=".85"/><stop offset="1" stop-color="#fff4dc" stop-opacity="0"/></radialGradient>
<clipPath id="${id}-photo"><rect x="-205" y="-242" width="410" height="282" rx="34"/></clipPath>
<filter id="${id}-shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="14" stdDeviation="17" flood-color="#0b1a10" flood-opacity="${shadowOpacity}"/></filter>`;

const cardStack = (id: string, backColor: string) => `
<rect x="268" y="204" width="470" height="520" rx="54" fill="${backColor}" transform="rotate(-9.17 503 464)" filter="url(#${id}-shadow)"/>
<rect x="292" y="252" width="470" height="540" rx="56" fill="url(#${id}-card)" transform="rotate(4.01 527 522)" filter="url(#${id}-shadow)"/>
<g transform="translate(527 522) rotate(4.01)">
<rect x="-205" y="-242" width="410" height="282" rx="34" fill="url(#${id}-sky)"/>
<g clip-path="url(#${id}-photo)">
<circle cx="82" cy="-150" r="120" fill="url(#${id}-sun)"/>
<path d="M-205 -40C-60 -150 80 10 205 -60L205 40L-205 40Z" fill="#7fa88a"/>
<path d="M-205 10C-20 -70 120 60 205 -20L205 40L-205 40Z" fill="#385d49"/>
</g>
<g transform="translate(82 -150)" fill="#fff">${[0, 45, 90, 135].map(bar).join("")}</g>
${["#385d49", "#e8836b", "#f1c25f"].map((color, index) => swatch(index, color)).join("")}
<rect x="30" y="106" width="175" height="22" rx="11" fill="#dfe7df"/>
<rect x="30" y="148" width="120" height="22" rx="11" fill="#dfe7df"/>
</g>`;

export const logoSVG = (label = "Taste") => `<svg viewBox="100 100 824 824" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label}">
<defs>
<linearGradient id="tl-tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5a8c6c"/><stop offset="1" stop-color="#2c4c3b"/></linearGradient>
<radialGradient id="tl-glow" cx="380" cy="164" r="560" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".18"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
${cardDefs("tl", 0.38)}
</defs>
<rect x="100" y="100" width="824" height="824" rx="186" fill="url(#tl-tile)"/>
<rect x="100" y="100" width="824" height="824" rx="186" fill="url(#tl-glow)"/>
${cardStack("tl", "#f3d8c8")}
</svg>`;

export const emptyLibrarySVG = () => `<svg viewBox="200 140 620 720" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<defs>${cardDefs("te", 0.16)}</defs>
<ellipse cx="515" cy="820" rx="230" ry="20" fill="#2c4c3b" opacity=".08"/>
${cardStack("te", "#f3d8c8")}
</svg>`;

export const faviconLink = () =>
  `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(logoSVG().replace(/\n/g, ""))}">`;
