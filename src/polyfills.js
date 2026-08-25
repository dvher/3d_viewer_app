// Three.js loaders assume a browser environment. React Native (Hermes) lacks a
// few globals they need, so we install lightweight polyfills here.
//
//  - TextEncoder / TextDecoder: used by GLTFLoader (GLB parsing) and OBJ text decode.
//  - DOMParser: used by ThreeMFLoader to read the 3MF model XML.
//
// This file is imported first in App.js so the globals exist before any loader runs.
import { TextEncoder, TextDecoder } from 'text-encoding';
import { DOMParser } from '@xmldom/xmldom';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = TextDecoder;
}
if (typeof global.DOMParser === 'undefined') {
  global.DOMParser = DOMParser;
}
