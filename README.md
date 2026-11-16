# Métro Duel

Retrouve de mémoire les 321 stations du métro de Paris (lignes 1 à 14, 3 bis, 7 bis) sur une carte, en 60 minutes. Seul, ou en duel en direct.

## Lancer en local

```bash
npm install
npm start        # http://localhost:3000
```

Pour tester le duel seul : ouvre le site dans deux onglets, crée une partie dans l'un, rejoins-la dans l'autre.

## Comment ça marche

- `public/` : le site (HTML, CSS, JS sans framework). `app.js` contient le jeu, `live.js` la liaison WebSocket, `data.js` les stations et les lignes.
- `server.js` : un seul processus Node qui sert `public/` et relaie en WebSocket (`/ws`) l'état des joueurs d'un même salon. Il ne connaît pas les règles et ne stocke rien.
- Une partie = un salon nommé par un code à 4 caractères. Chaque joueur publie son état (pseudo, stations trouvées, heure de départ) ; l'autre le reçoit en direct. Le lien d'invitation est `https://ton-site/#duel-code`.
- Deux règles : **Course** (chacun sa carte) et **Conquête** (une station appartient au premier qui la trouve).

## Mettre en ligne

Il faut un hébergeur qui garde un processus Node ouvert avec les WebSockets (un hébergement purement statique comme GitHub Pages ne suffit pas pour le serveur).

**Render (offre gratuite)** : New → Web Service → choisis ce dépôt, Build Command `npm install`, Start Command `npm start`, Health Check Path `/healthz`, instance Free. Ajoute la variable `TRUST_PROXY=1`. Sur l'offre gratuite, le service s'endort après 15 minutes sans trafic et met environ une minute à se réveiller.

**Docker** (Fly.io, Koyeb, VPS…) : `docker build -t metro-duel . && docker run -p 3000:3000 metro-duel`.

**Site et serveur séparés** : si `public/` est hébergé ailleurs, renseigne l'adresse du serveur dans `public/config.js` (`wsUrl`) et autorise le site côté serveur avec `ALLOWED_ORIGINS=https://ton-site`.

### Variables d'environnement

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `PORT` | port d'écoute | 3000 |
| `TRUST_PROXY` | `1` derrière un proxy (lit `X-Forwarded-For`) | désactivé |
| `ALLOWED_ORIGINS` | sites autorisés à ouvrir la WebSocket, séparés par des virgules | même origine que le site |
| `MAX_CONNECTIONS` / `MAX_PER_IP` | plafonds de connexions | 2000 / 30 |

## Tests

```bash
npm test
```

Les tests couvrent le serveur (fichiers statiques, relais, limites, origines). Le duel dans le navigateur a été vérifié avec deux joueurs simulés, pas encore sur un serveur en ligne.

## Mettre à jour les données

`tools/build_data.py <transit.store> <dossier_geo> <sortie.json>` reconstruit stations, lignes, contour de Paris et Seine. Le résultat se colle dans `public/data.js` (`window.METRO_DATA = …;`). À refaire à l'ouverture de la ligne 18.

## Sources des données

- Stations et lignes : open data Île-de-France Mobilités, via la base publiée par [Métropolist](https://github.com/alexislours/metropolist) (MIT). Vérifie les conditions de licence d'Île-de-France Mobilités avant un usage commercial.
- Contours : IGN Admin Express via [france-geojson](https://github.com/gregoiredavid/france-geojson), arrondissements via [click_that_hood](https://github.com/codeforgermany/click_that_hood). La Seine est déduite des limites de communes : elle est approximative.
