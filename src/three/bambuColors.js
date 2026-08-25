// Real Bambu Lab filament colors, sourced from the community swatch library
// filamentcolors.xyz (manufacturer 170, "Bambu Lab") and bundled statically so
// the app never needs the network at runtime.
//
// Used for:
//  - the default per-model tint palette (BAMBU_PALETTE), and
//  - a fallback palette for Bambu 3MF files that don't embed their own
//    `filament_colour` list.

// Named reference set (name -> hex string), handy for future name-based lookups.
export const BAMBU_COLORS = [
  { name: 'Black', hex: '#3D3D3C' },
  { name: 'White Jade', hex: '#ECEADE' },
  { name: 'Marble White', hex: '#DBDDDC' },
  { name: 'Red', hex: '#C13A3D' },
  { name: 'Maroon Red', hex: '#8F3D41' },
  { name: 'Bambu Green', hex: '#00A553' },
  { name: 'Mistletoe Green', hex: '#2E7759' },
  { name: 'Blue', hex: '#23529A' },
  { name: 'Cyan', hex: '#009ACE' },
  { name: 'Blue Grey', hex: '#647988' },
  { name: 'Yellow', hex: '#FDD803' },
  { name: 'Sunflower Yellow', hex: '#FFBD25' },
  { name: 'Orange', hex: '#F07745' },
  { name: 'Purple', hex: '#6B6FB2' },
  { name: 'Magenta', hex: '#C55498' },
  { name: 'Pink', hex: '#FF7896' },
  { name: 'Brown', hex: '#9A6152' },
  { name: 'Bronze', hex: '#867254' },
  { name: 'Grey', hex: '#8B9398' },
  { name: 'Dark Gray', hex: '#616364' },
];

const toInt = (hex) => parseInt(hex.replace('#', ''), 16);

// A distinct, well-spread ordered palette (as integers) for tinting imported
// models and for indexing when a Bambu file references filament slots but does
// not ship its own colors.
export const BAMBU_PALETTE = [
  'C13A3D', // Red
  '009ACE', // Cyan
  '00A553', // Bambu Green
  'FDD803', // Yellow
  '6B6FB2', // Purple
  'F07745', // Orange
  'C55498', // Magenta
  '23529A', // Blue
  'FF7896', // Pink
  '9A6152', // Brown
  '8B9398', // Grey
  '3D3D3C', // Black
  'ECEADE', // White Jade
  'FFBD25', // Sunflower Yellow
  '647988', // Blue Grey
  '616364', // Dark Gray
].map(toInt);
