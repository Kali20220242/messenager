import { registerRootComponent } from "expo";
import { Platform } from "react-native";

if (Platform.OS !== "web") {
  require("./src/store/SignalStore").installSignalRuntime();
}

import App from "./App";

registerRootComponent(App);
