import nextVitals from "eslint-config-next/core-web-vitals";
import baseConfig from "../../eslint.config.js";

const config = [...nextVitals, ...baseConfig];

export default config;
