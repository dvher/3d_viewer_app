import { registerRootComponent } from 'expo';
import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App)
// and sets up the Expo environment appropriately for both Expo Go and native
// builds. Using an explicit root index.js (instead of expo/AppEntry.js) avoids
// pnpm's nested node_modules breaking AppEntry's relative import of ../../App.
registerRootComponent(App);
