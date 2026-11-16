/*
 * Réglages du site.
 * transport : façon de relier les deux joueurs d'un duel.
 *   "p2p" (par défaut) : liaison directe entre navigateurs (p2p.js, WebRTC par PeerJS). Marche sur un
 *         hébergement purement statique comme GitHub Pages : aucun serveur à faire tourner.
 *   "ws"  : par le serveur Node du dépôt (node server.js), qui relaie en WebSocket (live.js).
 *         La liste des parties ouvertes n'existe que dans ce mode.
 * wsUrl : en mode "ws" seulement. Vide quand le site et le serveur sont servis par le même processus ;
 *         sinon l'adresse complète du serveur, par exemple "wss://metro-duel.onrender.com/ws".
 */
window.METRO_CONFIG = { transport: "p2p", wsUrl: "" };
