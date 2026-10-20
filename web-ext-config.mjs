// web-ext (lint, build, run) : ce qui ne fait pas partie de l'extension. join/ et player/ sont
// des pages publiées sur GitHub Pages (l'extension les ouvre par leur adresse), common/ y est
// aussi lu par la page invité mais reste dans le paquet pour le moteur.
export default {
  ignoreFiles: ["tests", "web-ext-config.mjs", "README.fr.md", "join", "player"],
};
