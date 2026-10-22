const { ModuleFederationPlugin } = require("webpack").container;
module.exports = {
  plugins: [
    new ModuleFederationPlugin({
      name: "shop",
      exposes: { "./Cart": "./src/cart", "./Ghost": "./src/ghost" },
      remotes: { admin: "admin@http://localhost:3002/remoteEntry.js" },
      shared: { react: { singleton: true } },
    }),
  ],
};
