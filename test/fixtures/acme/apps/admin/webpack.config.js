const { ModuleFederationPlugin } = require("webpack").container;
module.exports = {
  plugins: [new ModuleFederationPlugin({ name: "admin", filename: "remoteEntry.js", exposes: { "./Dashboard": "./src/Dashboard" }, shared: ["react"] })],
};
