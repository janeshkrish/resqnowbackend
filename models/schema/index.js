import * as identity from "./identity.js";
import * as technicians from "./technicians.js";
import * as requests from "./requests.js";
import * as commerce from "./commerce.js";
import * as catalog from "./catalog.js";
import * as content from "./content.js";
import * as admin from "./admin.js";
import * as fuel from "./fuel.js";
import * as appAnalytics from "./appAnalytics.js";

export const TABLES = Object.freeze({
  ...identity,
  ...technicians,
  ...requests,
  ...commerce,
  ...catalog,
  ...content,
  ...admin,
  ...fuel,
  ...appAnalytics,
});
