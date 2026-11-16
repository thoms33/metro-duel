# Métro Duel

Retrouve de mémoire les 321 stations du métro de Paris (lignes 1 à 14, 3 bis, 7 bis) sur une carte, en 60 minutes. Seul, ou en duel 1 contre 1 en direct, sur ordinateur comme sur téléphone.

Site public : https://thoms33.github.io/metro-duel/

## Jouer

- **Seul** : « Jouer seul », choisis la durée. La partie se garde dans le navigateur : tu peux la reprendre plus tard.
- **Partie rapide** : « Duel 1 contre 1 » → « Trouver un adversaire ». Rien à partager : on rejoint la première partie ouverte, ou, si personne n'attend, on en ouvre une qui démarre toute seule dès qu'un autre joueur touche le même bouton. Si deux joueurs cherchent au même moment, l'un rejoint l'autre.
- **Duel avec quelqu'un de précis** : « Duel 1 contre 1 » → « Créer la partie ». La partie apparaît chez tous ceux qui ont ouvert l'écran du duel : l'adversaire touche « Rejoindre » dans la liste. Il peut aussi ouvrir le lien envoyé avec « Partager le lien », ou taper le code à 4 caractères. L'hôte lance, un décompte de 4 secondes démarre pour les deux.
- Deux règles : **Course** (chacun sa carte) et **Conquête** (une station appartient au premier qui la trouve).

## Lancer en local

```bash
npm install
npm start        # http://localhost:3000
```

N'importe quel serveur de fichiers statiques sur `public/` fait aussi l'affaire. Pour tester le duel seul : ouvre le site dans deux onglets, crée une partie dans l'un, rejoins-la dans l'autre. Il faut Internet pour le duel (mise en relation PeerJS).

## Comment ça marche

- `public/` : le site (HTML, CSS, JS sans framework). `app.js` contient le jeu, `data.js` les stations et les lignes, `config.js` les réglages.
- Le duel passe par des « salons » : chaque joueur y publie son état (pseudo, stations trouvées, heure de départ) et reçoit celui de l'autre. Deux façons de les relier, au choix dans `config.js` :
  - **`p2p`** (par défaut) : `p2p.js`, liaison directe entre navigateurs en WebRTC, par [PeerJS](https://peerjs.com) (MIT, copie dans `public/vendor/`, chargée seulement en duel). La mise en relation passe par le serveur public de PeerJS, ensuite les données vont d'un joueur à l'autre. Le premier arrivé dans un salon en tient l'identifiant (`metro-duel-duel-<code>`) et relaie l'état des autres ; s'il part, un autre reprend la main. La liste des parties ouvertes passe par un salon d'accueil commun (`metro-duel-lobby`), rejoint à l'ouverture de l'écran du duel. Aucun serveur à faire tourner : un hébergement statique suffit.
  - **`ws`** : `live.js` + `server.js`, un processus Node qui sert `public/` et relaie en WebSocket (`/ws`). Il ne connaît pas les règles et ne stocke rien.
- Le lien d'invitation est `https://ton-site/#duel-code`.

## Mettre en ligne

**GitHub Pages** (mode `p2p`, par défaut) : le flux `.github/workflows/publier.yml` publie `public/` à chaque envoi sur `main`. À faire une fois : Settings → Pages → Source « GitHub Actions ».

**Serveur Node** (mode `ws`) : il faut un hébergeur qui garde un processus ouvert avec les WebSockets.

- Render (offre gratuite) : New → Web Service → ce dépôt, Build Command `npm install`, Start Command `npm start`, Health Check Path `/healthz`, variable `TRUST_PROXY=1`. Le service s'endort après 15 minutes sans trafic et met environ une minute à se réveiller.
- Docker (Fly.io, Koyeb, VPS…) : `docker build -t metro-duel . && docker run -p 3000:3000 metro-duel`.
- Site et serveur séparés : renseigne l'adresse du serveur dans `public/config.js` (`wsUrl`) et autorise le site côté serveur avec `ALLOWED_ORIGINS=https://ton-site`.

### Variables d'environnement du serveur

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

Les tests couvrent le serveur du mode `ws` (fichiers statiques, relais, limites, origines).

## Mettre à jour les données

`tools/build_data.py <transit.store> <dossier_geo> <sortie.json>` reconstruit stations, lignes, contour de Paris et Seine. Le résultat se colle dans `public/data.js` (`window.METRO_DATA = …;`). À refaire à l'ouverture de la ligne 18.

## Sources des données

- Stations et lignes : open data Île-de-France Mobilités, via la base publiée par [Métropolist](https://github.com/alexislours/metropolist) (MIT). Vérifie les conditions de licence d'Île-de-France Mobilités avant un usage commercial.
- Contours : IGN Admin Express via [france-geojson](https://github.com/gregoiredavid/france-geojson), arrondissements via [click_that_hood](https://github.com/codeforgermany/click_that_hood). La Seine est déduite des limites de communes : elle est approximative.
