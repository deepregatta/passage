import { ruleLabelTranslations, ruleSubjectTranslations } from './lib/ruleLabels.js';
import { useLayoutEffect, useRef } from 'react';

export const LANGUAGE_STORAGE_KEY = 'passage-language';

export function getDefaultLanguage() {
  if (typeof navigator === 'undefined') return 'en';
  const preferred = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages
    : [navigator.language];
  return preferred.some((language) => String(language).toLowerCase().startsWith('fr')) ? 'fr' : 'en';
}

/** The crawlable French page lives under /fr/; on that path the URL wins. */
export function getLanguageFromPath(pathname) {
  return /^\/fr(\/|$)/.test(pathname) ? 'fr' : null;
}

export function getInitialLanguage() {
  if (typeof location !== 'undefined') {
    const fromPath = getLanguageFromPath(location.pathname);
    if (fromPath) return fromPath;
  }
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved === 'en' || saved === 'fr') return saved;
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return getDefaultLanguage();
}

// Passage's original UI predates i18n and keeps its copy close to each chart.
// This catalogue deliberately uses the English copy as its key, which lets old
// snapshots and lazy-loaded panels participate without changing their schemas.
const FR = {
  "Previous run": "Analyse précédente",
  "Latest run": "Dernière analyse",
  "forecast scenarios exceed your wind limit": "scénarios de prévision dépassent votre limite de vent",
  "forecast scenarios exceed your gust limit": "scénarios de prévision dépassent votre limite de rafales",
  "local time · avg": "heure locale · moy.",
  "contributors, seamarks © OpenSeaMap": "contributeurs, balisage © OpenSeaMap",
  "contributors": "contributeurs",

  "· arrives": "· arrivée",
  "/2 endpoints": "/2 extrémités",
  "h passage": "h de traversée",
  "Causal attribution was unavailable in the original run.": "L’analyse initiale ne permettait pas d’attribuer les conditions à un système météo.",
  "EMULATED DEMO · NOT A SKILL CLAIM": "DÉMONSTRATION SIMULÉE · AUCUN RÉSULTAT RÉEL",
  "OBSERVATION SOURCE": "SOURCE DES OBSERVATIONS",
  "leg · valid UTC": "tronçon · heure UTC",
  "material miss; widen margin": "écart significatif, marge à élargir",
  "useful magnitude": "intensité utile",
  "ERA5 comparisons use a reanalysis that assimilates observations but is not independent ground truth (brief §9). Sample sizes are always shown. Passage calls a probability calibrated only when the record supports it.": "Les comparaisons fondées sur ERA5 utilisent une réanalyse qui assimile des observations, sans constituer une vérité terrain indépendante (spécification §9). La taille des échantillons est toujours indiquée. Passage ne qualifie une probabilité d’étalonnée que lorsque l’historique le permet.",
  "How the forecasts in your briefings compared with what actually happened. This is the page where Passage earns your trust. Every number carries its sample size and how independent the observation really was.": "Comparez les prévisions de vos briefings avec les conditions réellement observées. Chaque résultat indique la taille de son échantillon et le degré d’indépendance des observations.",
  "No calibration data yet. Verified analyses will build this record over time. Emulated observations stay labeled and never count as real skill.": "Aucune donnée d’étalonnage pour le moment. Les analyses vérifiées construiront cet historique. Les observations simulées restent signalées et ne comptent jamais comme résultats réels.",
  "Not verified yet. After the passage window, the verification job will match this frozen forecast against later observations.": "Pas encore vérifiée. Une fois la traversée terminée, cette prévision figée sera comparée aux observations disponibles.",
  "Skill claims use": "Les mesures de fiabilité reposent sur",
  "real ERA5 cases.": "cas ERA5 réels.",
  "shown for demo only.": "uniquement pour la démonstration.",
  "emulated observations": "observations simulées",
  "not independently observed": "sans observation indépendante",
  "partially observed": "partiellement observé",
  "reanalysis-referenced": "référencé par réanalyse",
  "verified near observation": "vérifié près d’une observation",
  "leg · hour": "tronçon · heure",
  "pass ·": "réussites ·",
  "fail ·": "échecs ·",
  "pending": "en attente",
  "case": "cas",
  "cases": "cas",

  "reading deterministic forecast tiles": "lecture des tuiles de prévision déterministe",
  "checking ensemble tiles": "vérification des tuiles d’ensemble",
  "reading wave tiles": "lecture des tuiles de vagues",
  "reading hazard and model-comparison tiles": "lecture des tuiles de dangers et de comparaison des modèles",
  "Route conditions and limit checks remain available, but this run does not attribute them to a weather system.": "Les conditions sur la route et les vérifications des limites restent disponibles, mais cette analyse ne les attribue pas à un système météo.",
  "Synoptic availability: unavailable (no prepared synoptic run was supplied). Route conditions and limit checks remain available, but this run does not attribute them to a weather system.": "Disponibilité synoptique : indisponible (aucune analyse synoptique préparée n’a été fournie). Les conditions sur la route et les vérifications des limites restent disponibles, mais cette analyse ne les attribue pas à un système météo.",
  "The forecasts disagree too much to assess this passage against your limits.": "Les prévisions divergent trop pour évaluer cette traversée par rapport à vos limites.",
  "This state overrides the personal-limit summary and does not assert a numeric limit exceedance.": "Cet état prévaut sur le résumé des limites personnelles et n’affirme aucun dépassement chiffré.",
  "All": "Tous",
  "your": "votre",
  "near": "près de",
  "within": "dans les limites",
  "reach": "atteignent",
  "Delete the briefing \"": "Supprimer le briefing «",
  ")? This cannot be undone.": ") ? Cette action est irréversible.",

  // Production errors, progress, and independently rendered narrative fragments.
  "No forecast tiles cover this area yet": "Aucune tuile de prévision ne couvre encore cette zone",
  "Couldn't load the forecast tiles. Check your connection and try again.": "Impossible de charger les tuiles de prévision. Vérifiez votre connexion et réessayez.",
  "This departure is beyond the forecast horizon": "Ce départ dépasse l’horizon des prévisions",
  "Currents unavailable right now. This route uses wind alone.": "Courants indisponibles pour le moment. Cette route utilise uniquement le vent.",
  "Drawing forecast…": "Tracé de la prévision…",
  "Loading passage chart…": "Chargement de la carte de traversée…",
  "reading forecast run manifest": "lecture du manifeste du cycle de prévision",
  "evaluating against your limits": "évaluation par rapport à vos limites",
  "reading current tiles": "lecture des tuiles de courants",
  "loading coastline": "chargement du trait de côte",
  "loading forecast tiles": "chargement des tuiles de prévision",
  "loading current tiles": "chargement des tuiles de courants",
  "loading prepared data": "chargement des données préparées",
  "saving immutable snapshot": "enregistrement du briefing figé",
  "starting": "démarrage",
  "computing route": "calcul de la route",
  "scanning departures": "comparaison des départs",
  "Specify at least two valid waypoints.": "Indiquez au moins deux points de route valides.",
  "Click a point in open water near both ends of the passage": "Cliquez en pleine eau près de chaque extrémité de la traversée",
  "Couldn't load the coastline data needed for safe routing": "Impossible de charger les données côtières nécessaires au routage sécurisé",
  "This browser cannot decompress the coastline data": "Ce navigateur ne peut pas décompresser les données côtières",
  "Forecast tiles unavailable: no readable weather run": "Tuiles de prévision indisponibles : aucun cycle météo lisible",
  "Forecast tiles unavailable for this area": "Tuiles de prévision indisponibles pour cette zone",
  "Antimeridian-crossing routes are not supported yet": "Les routes traversant l’antiméridien ne sont pas encore prises en charge",
  "Route is outside the coastline mask": "La route se trouve hors du masque côtier",
  "Start or finish is on land": "Le départ ou l’arrivée se trouve à terre",
  "No sea node near start/finish": "Aucun point en mer près du départ ou de l’arrivée",
  "This browser cannot store briefings (no IndexedDB)": "Ce navigateur ne peut pas enregistrer de briefings (IndexedDB indisponible)",
  "arrives": "arrivée",
  "avg": "moy.",
  "forecast scenarios exceed": "scénarios de prévision dépassent",
  ". This is a raw count (": ". Il s’agit d’un décompte brut (",
  "%), not a calibrated probability.": "%), et non d’une probabilité étalonnée.",
  "not available": "indisponible",
  "n/a": "s.o.",
  "median (P50)": "médiane (P50)",
  "control": "témoin",
  "member": "membre",
  "members": "membres",
  "▾ search": "▾ rechercher",
  "seamarks © OpenSeaMap": "balisage © OpenSeaMap",
  "nm · arrive": "M · arrivée",
  "Conditions along your route:": "Conditions le long de votre route :",
  "Select language": "Choisir la langue",
  "synoptic chart": "carte synoptique",
  "tracked positions": "positions suivies",
  "Synoptic": "Synoptique",
  "h old": "h écoulées",
  "Causal attribution unavailable for this legacy snapshot.": "Attribution causale indisponible pour ce briefing ancien.",
  "UTC · recheck before departure": "UTC · revérifiez avant le départ",
  "UTC. Check again before departure.": "UTC. Vérifiez à nouveau avant le départ.",
  "close to": "proche de",
  "crosses your passage window": "traverse votre fenêtre de passage",
  "crosses your route.": "traverse votre route.",
  "next forecast ~": "prochaine prévision vers",
  "Selected evidence summary": "Résumé des éléments probants sélectionnés",
  "% · not calibrated": "% · non étalonné",
  "over ·": "en dépassement ·",
  "My passage": "Ma traversée",
  "departure times could not be assessed and are not shown.": "heures de départ n’ont pas pu être évaluées et ne sont pas affichées.",
  "local time (": "heure locale (",
  "Check the published forecast before departure.": "Consultez la prévision publiée avant le départ.",
  "Next forecast update time unavailable.": "Heure de la prochaine mise à jour indisponible.",
  "No future publication estimate is available from the loaded forecast metadata and known tile-pipeline schedules.": "Les métadonnées des prévisions chargées et les calendriers connus de la chaîne de tuiles ne permettent pas d’estimer une prochaine publication.",
  "Synthetic runs have no scheduled update.": "Les cycles synthétiques n’ont aucune mise à jour programmée.",
  "Absence of a flag must not be read as absence of risk (brief §5).": "L’absence de signalement ne doit pas être interprétée comme une absence de risque (briefing §5).",
  "Reason: no prepared synoptic run was supplied.": "Raison : aucune analyse synoptique préparée n’a été fournie.",
  "no prepared synoptic run was supplied": "aucune analyse synoptique préparée n’a été fournie",
  "Synoptic availability: unavailable (no prepared synoptic run was supplied).": "Disponibilité synoptique : indisponible (aucune analyse synoptique préparée n’a été fournie).",
  "This run has no causal attribution.": "Cette analyse ne comporte pas d’attribution causale.",
  "Reassess after the next model run.": "Réévaluez après le prochain cycle du modèle.",
  "Front-type labels withheld pending corroboration (§4.1).": "Les types de fronts ne sont pas indiqués dans l’attente d’une corroboration (§4.1).",
  "Provider modes are recorded in the snapshot inputs.": "Les modes des fournisseurs sont consignés dans les données d’entrée du briefing.",
  "Read the official bulletin first.": "Lisez d’abord le bulletin officiel.",
  "The charts track it over the next few days.": "Les cartes suivent son déplacement au cours des prochains jours.",
  "The national weather service has an active marine warning for part of your route.": "Le service météorologique national a émis une alerte marine active pour une partie de votre route.",
  "Previous run keeps the low west of the route longer.": "L’analyse précédente maintient la dépression à l’ouest de la route plus longtemps.",

  "Inspect example bulletin": "Examiner le bulletin de l’exemple",
  "Free · no signup · no route setup": "Gratuit · sans inscription · sans tracer de route",
  "Synthetic / emulated example. Not a live forecast or a safety decision.": "Exemple synthétique / émulé. Ni prévision en direct, ni décision de sécurité.",
  "Example briefing": "Exemple de briefing",
  "First: inspect the warning and its bulletin. Official information and skipper judgement remain authoritative.": "Commencez par examiner l’avertissement et son bulletin. Les informations officielles et le jugement du skipper font autorité.",
  "Plan my own passage": "Planifier ma propre traversée",
  "The example could not be loaded. Try again or return to the planner.": "Impossible de charger l’exemple. Réessayez ou revenez au planificateur.",
  "Try again": "Réessayer",
  "Loading example briefing…": "Chargement de l’exemple de briefing…",

  'Loading passage instruments…': 'Chargement des instruments de navigation…',
  'Plan': 'Planifier',
  'Brief': 'Briefing',
  'Watch': 'Suivre',
  'Verify': 'Vérifier',
  'My limits': 'Mes limites',
  'My briefings': 'Mes briefings',
  'Causal brief': 'Briefing causal',
  'Evidence': 'Éléments probants',
  'evidence:': 'éléments probants :',
  'NM': 'M',
  'Changes': 'Évolutions',
  'Track record': 'Bilan de fiabilité',
  'Case study': 'Étude de cas',
  'Skip to briefing content': 'Aller au contenu du briefing',
  'SNAPSHOT': 'BRIEFING',
  'Passage home': 'Accueil de Passage',
  'Passage stages': 'Étapes de Passage',
  'no briefing open yet': 'aucun briefing ouvert',
  'by DeepRegatta': 'par DeepRegatta',
  'Privacy': 'Confidentialité',
  'Terms': "Conditions d’utilisation",
  'Legal notice': 'Mentions légales',
  'DeepRegatta information': 'Informations DeepRegatta',
  'Share this analysis': 'Partager cette analyse',
  'Link copied': 'Lien copié',
  'Request a race / report a data issue': 'Demander une course / signaler un problème de données',
  'Request a race or report an issue': 'Demander une course ou signaler un problème',
  'Request a race': 'Demander une course',
  'Report a data issue': 'Signaler un problème de données',
  'Other feedback': 'Autre commentaire',
  'Which race or passage should we cover, or what looks wrong?': 'Quelle course ou traversée devrions-nous couvrir, ou qu’est-ce qui semble incorrect ?',
  'Send': 'Envoyer',
  'Sending…': 'Envoi…',
  'Thanks! Your message has been received.': 'Merci ! Votre message a bien été reçu.',
  'Something went wrong. Please try again or email': 'Une erreur est survenue. Réessayez ou écrivez à',
  'Close': 'Fermer',
  'No account needed.': 'Aucun compte requis.',
  'Next: save or share this planning context': 'Ensuite : enregistrez ou partagez ce contexte de planification',
  'Next: explore another scenario': 'Ensuite : explorez un autre scénario',
  'DeepRegatta legal and contact links': 'Liens juridiques et contact DeepRegatta',
  'A DeepRegatta instrument for offshore sailors': 'Un instrument DeepRegatta pour les navigateurs au large',
  'Plan a passage': 'Planifier une traversée',
  'Click the chart to drop waypoints (drag to adjust), or import a GPX file. The analysis runs right here in your browser.': 'Cliquez sur la carte pour placer des points de route (faites-les glisser pour les ajuster), ou importez un fichier GPX. L’analyse s’exécute directement dans votre navigateur.',
  'See an example briefing': 'Voir un exemple de briefing',
  'Route mode': 'Mode de route',
  'Draw my route': 'Tracer ma route',
  'Compute a route': 'Calculer une route',
  'Name': 'Nom',
  'Boat speed (kt) · slow / usual / fast': 'Vitesse du bateau (nd) · lente / habituelle / rapide',
  'slow speed': 'vitesse lente',
  'nominal speed': 'vitesse habituelle',
  'fast speed': 'vitesse rapide',
  'Your boat (ORC polar)': 'Votre bateau (polaire ORC)',
  'Choose your boat…': 'Choisissez votre bateau…',
  'Search boat models': 'Rechercher des modèles de bateau',
  'Loading boat database…': 'Chargement de la base de bateaux…',
  'Boat models': 'Modèles de bateau',
  'Not listed? Generic by boat length': 'Absent de la liste ? Polaire générique selon la longueur',
  'Generic cruiser polars': 'Polaires génériques de croiseur',
  'Compute route': 'Calculer la route',
  'Mark a start and finish on the chart. Passage uses the forecast, available currents and your boat polar to find a route.': 'Placez un départ et une arrivée sur la carte. Passage utilise les prévisions, les courants disponibles et la polaire de votre bateau pour calculer une route.',
  'Weather-routed · includes polar uncertainty · ready to check': 'Route météo · incertitude de la polaire incluse · prête à vérifier',
  'Departure · local time': 'Départ · heure locale',
  'Departure date': 'Date de départ',
  'Departure time, 24-hour clock': 'Heure de départ, format 24 heures',
  '24-hour clock (HH:mm)': 'format 24 heures (HH:mm)',
  '24-hour local time': 'heure locale au format 24 heures',
  'your local time': 'votre heure locale',
  'local time': 'heure locale',
  'undo': 'annuler',
  'clear': 'effacer',
  'Import GPX…': 'Importer un GPX…',
  'Check this passage against my limits': 'Vérifier cette traversée selon mes limites',
  'Mark at least two points on the chart: your start and destination.': 'Placez au moins deux points sur la carte : votre départ et votre destination.',
  'Mark a start and finish on the chart.': 'Placez un départ et une arrivée sur la carte.',
  'Checking runs the analysis and saves the briefing to My briefings. Until then your draft stays here on this page.': 'La vérification lance l’analyse et enregistre le briefing dans Mes briefings. Jusque-là, votre brouillon reste sur cette page.',
  'Compare departure times (next 5 days)': 'Comparer les heures de départ (5 prochains jours)',
  'Departure comparison ready. Choose a time below the chart.': 'Comparaison des départs prête. Choisissez une heure sous la carte.',
  'Runs in your browser · forecasts fetched live · saved as an immutable snapshot.': 'S’exécute dans votre navigateur · prévisions récupérées en direct · enregistrement sous forme de briefing immuable.',
  'Departure comparison': 'Comparaison des départs',
  'Departure comparison · next 5 days': 'Comparaison des départs · 5 prochains jours',
  'same route, different weather': 'même route, météo différente',
  'each departure sails its own computed route': 'chaque départ suit sa propre route calculée',
  'Briefings are frozen when you make them. Reopen one here, or compare its forecast with later observations in Track record.': 'Les briefings sont figés à leur création. Rouvrez-en un ici ou comparez sa prévision aux observations ultérieures dans le Bilan de fiabilité.',
  'No briefings yet.': 'Aucun briefing pour le moment.',
  'Plan a passage, set a departure time and check it against your limits.': 'Planifiez une traversée, choisissez une heure de départ et vérifiez-la selon vos limites.',
  'example': 'exemple',
  'Delete this briefing': 'Supprimer ce briefing',
  'Your declared limits': 'Vos limites déclarées',
  'Set the conditions you will accept for this passage. Presets are only a starting point. Every value remains editable. Squall and storm tolerance never changes with a preset.': 'Définissez les conditions que vous acceptez pour cette traversée. Les préréglages sont un point de départ. Chaque valeur reste modifiable. La tolérance aux grains et aux tempêtes ne change jamais avec un préréglage.',
  'Max sustained · upwind': 'Vent moyen max. · près',
  'Max sustained · reach': 'Vent moyen max. · travers',
  'Max sustained · downwind': 'Vent moyen max. · portant',
  'Max gusts': 'Rafales max.',
  'Max wave height': 'Hauteur de vague max.',
  'Max steepness': 'Cambrure max.',
  'Min visibility': 'Visibilité min.',
  'Scenario fraction floor': 'Seuil de fraction des scénarios',
  'night sailing acceptable': 'navigation de nuit acceptable',
  'Loading profile…': 'Chargement du profil…',
  'Data providers': 'Fournisseurs de données',
  'Feeds marked': 'Les flux marqués',
  'contain synthetic test values. They stay visibly marked and must never inform a real passage decision.': 'contiennent des valeurs synthétiques de test. Elles restent clairement signalées et ne doivent jamais guider une décision de traversée réelle.',
  'Glossary': 'Glossaire',
  'Open a snapshot first.': 'Ouvrez d’abord un briefing.',
  'No ensemble limit claim is available for this snapshot.': 'Aucune affirmation de limite issue de l’ensemble n’est disponible pour ce briefing.',
  'raw count, not a calibrated probability': 'décompte brut, pas une probabilité étalonnée',
  'inspect claim': 'examiner l’affirmation',
  'Open a briefing to view its case study.': 'Ouvrez un briefing pour voir son étude de cas.',
  'Open a passage briefing first.': 'Ouvrez d’abord un briefing de traversée.',
  'First analysis of this passage': 'Première analyse de cette traversée',
  'Nothing to compare yet. Reassess after the next model run.': 'Rien à comparer pour le moment. Réévaluez après la prochaine sortie des modèles.',
  'Comparing frozen runs…': 'Comparaison des analyses figées…',
  'No material change. The forecast held steady.': 'Aucun changement significatif. La prévision est restée stable.',
  'Edited change story · previous → latest': 'Synthèse des évolutions · précédente → dernière',
  'Event onset at the route': 'Début de l’événement sur la route',
  'previous': 'précédente',
  'latest': 'dernière',
  'earlier': 'plus tôt',
  'later': 'plus tard',
  'Choose a claim': 'Choisir une affirmation',
  'Selected claim': 'Affirmation sélectionnée',
  'Rule': 'Règle',
  'Route window': 'Fenêtre sur la route',
  'Raw fraction': 'Fraction brute',
  'Limit': 'Limite',
  'Model comparison · same interval': 'Comparaison des modèles · même intervalle',
  'agreement is not proof': 'l’accord ne constitue pas une preuve',
  'Agreement is not proof. This panel stays tied to the claim selected at left.': 'L’accord ne constitue pas une preuve. Ce panneau reste lié à l’affirmation sélectionnée à gauche.',
  'Text/table alternative for the plume': 'Alternative texte/table au panache',
  'median': 'médiane',
  'maximum': 'maximum',
  'your limit': 'votre limite',
  'members over': 'membres au-dessus',
  'No ensemble data for this leg.': 'Aucune donnée d’ensemble pour ce tronçon.',
  'No multi-model data in this snapshot.': 'Aucune donnée multimodèle dans ce briefing.',
  'Evidence · model guidance': 'Éléments probants · indication des modèles',
  'Loading chart…': 'Chargement de la carte…',
  'Show wind, gust and wave charts ▾': 'Afficher les graphiques du vent, des rafales et des vagues ▾',
  'Hide detailed charts ▴': 'Masquer les graphiques détaillés ▴',
  'Table alternative for route timeline': 'Tableau alternatif pour la chronologie de la route',
  'wind kt': 'vent nd',
  'gust kt': 'rafale nd',
  'waves m': 'vagues m',
  'status': 'état',
  'not assessed': 'non évalué',
  'Wind': 'Vent',
  'Gusts': 'Rafales',
  'Waves': 'Vagues',
  'knots': 'nœuds',
  'metres': 'mètres',
  'Before/after synoptic comparison unavailable for this legacy pair.': 'Comparaison synoptique avant/après indisponible pour cette ancienne paire.',
  'Previous': 'Précédente',
  'Latest': 'Dernière',
  'chart image no longer archived': 'image de la carte non archivée',
  'Synoptic chart unavailable': 'Carte synoptique indisponible',
  'This legacy run has route conditions, but no archived synoptic data.': 'Cette ancienne analyse contient les conditions sur la route, mais aucune donnée synoptique archivée.',
  'No tracked weather system meets your route in this window.': 'Aucun système météo suivi ne rencontre votre route dans cette fenêtre.',
  'The system is organizing west of the passage.': 'Le système s’organise à l’ouest de la traversée.',
  'The low and the boat occupy the same route window.': 'La dépression et le bateau occupent la même fenêtre sur la route.',
  'The system has crossed. Its strongest effect on your route is active.': 'Le système est passé. Son effet le plus fort sur votre route est actif.',
  'The low moves clear and the passage begins to ease.': 'La dépression s’éloigne et les conditions commencent à s’améliorer.',
  'No tracked system crosses your route window. The wider pattern still sets your wind.': 'Aucun système suivi ne traverse votre fenêtre de route. La configuration d’ensemble détermine néanmoins votre vent.',
  'High pressure dominates the picture. Expect the pattern to change slowly.': 'Les hautes pressions dominent la situation. Attendez-vous à une évolution lente.',
  'no closed pressure centres in the window': 'aucun centre de pression fermé dans la fenêtre',
  'Full screen': 'Plein écran',
  'Full chart': 'Carte entière',
  'Zoom to route': 'Zoomer sur la route',
  'Causal briefing playback': 'Lecture du briefing causal',
  'Close full-screen chart': 'Fermer la carte plein écran',
  'Pause passage playback': 'Mettre la lecture en pause',
  'Play passage playback': 'Lancer la lecture de la traversée',
  'Passage time': 'Temps de traversée',
  'departure': 'départ',
  'arrival': 'arrivée',
  'The weather story': 'L’histoire météo',
  'The forecast stays inside the limits you set. Check the latest run once more before you leave.': 'La prévision reste dans les limites fixées. Vérifiez une dernière fois le cycle le plus récent avant de partir.',
  'It is close to your limits. Read the two or three points on the right before deciding.': 'Les conditions sont proches de vos limites. Lisez les deux ou trois points à droite avant de décider.',
  'This forecast crosses your limits. Compare departure times before changing the route.': 'Cette prévision dépasse vos limites. Comparez les heures de départ avant de modifier la route.',
  'The models disagree near your limits. Wait for the next update before deciding.': 'Les modèles divergent près de vos limites. Attendez la prochaine mise à jour avant de décider.',
  'A marine warning covers your area. Read the official bulletin first.': 'Une alerte marine concerne votre zone. Lisez d’abord le bulletin officiel.',
  'An official marine warning covers part of your route. Read the bulletin before anything else.': 'Une alerte marine officielle couvre une partie de votre route. Lisez le bulletin en premier.',
  'A synthetic warning scenario covers part of your route. It tests the workflow and must not inform a real passage decision.': 'Un scénario d’alerte synthétique couvre une partie de votre route. Il sert à tester le fonctionnement et ne doit jamais guider une décision réelle.',
  'Passage chart · synced to playback': 'Carte de la traversée · synchronisée avec la lecture',
  'Along your route · conditions vs your limits': 'Le long de votre route · conditions et limites',
  'same time cursor': 'même curseur temporel',
  'Decision': 'Décision',
  'Within your declared limits': 'Dans vos limites déclarées',
  'Approaching your limits': 'Proche de vos limites',
  'Exceeds your limits': 'Dépasse vos limites',
  'Models disagree · reassess after the next run': 'Divergence des modèles · réévaluez après le prochain cycle',
  'Official warning active': 'Alerte officielle active',
  'within limits': 'dans les limites',
  'approaching': 'proche des limites',
  'exceeds': 'dépassement',
  'models disagree': 'divergence des modèles',
  'official warning': 'alerte officielle',
  'exceeded': 'dépassé',
  'unknown': 'inconnu',
  'EMULATED WARNING SCENARIO': 'SCÉNARIO D’ALERTE SIMULÉ',
  'emulated warning scenario': 'scénario d’alerte simulé',
  'emulated': 'simulé',
  'evidence': 'éléments probants',
  'Capability coverage': 'Couverture fonctionnelle',
  'derived from evidence · legacy snapshot': 'déduit des éléments probants · ancien briefing',
  'Published verification case · frozen snapshot': 'Cas de vérification publié · briefing figé',
  'What the forecast said, and what happened': 'Ce que prévoyait la météo et ce qui s’est produit',
  'Print / save PDF': 'Imprimer / enregistrer en PDF',
  'Observations not attached yet': 'Observations pas encore jointes',
  'The original forecast remains frozen. This report will populate only after observations are classified.': 'La prévision initiale reste figée. Ce rapport ne sera complété qu’après la classification des observations.',
  'The route forecast caught the event direction. The table records its timing and magnitude errors without hindsight edits.': 'La prévision sur la route a saisi l’évolution de l’événement. Le tableau consigne ses erreurs de chronologie et d’intensité sans réécriture a posteriori.',
  'Error decomposition': 'Décomposition de l’erreur',
  'variable': 'variable',
  'frozen forecast': 'prévision figée',
  'later observation': 'observation ultérieure',
  'error': 'erreur',
  'interpretation': 'interprétation',
  'Original interpretation': 'Interprétation initiale',
  'Lesson for the next passage': 'Leçon pour la prochaine traversée',
  'Treat event timing as a window. Keep your personal limit, then add the measured forecast error as margin.': 'Traitez la chronologie de l’événement comme une fenêtre. Conservez votre limite personnelle, puis ajoutez l’erreur de prévision mesurée comme marge.',
  'Corpus summary unavailable.': 'Résumé du corpus indisponible.',
  'This analysis': 'Cette analyse',
  'Calibration record': 'Historique d’étalonnage',
  'forecast': 'prévision',
  'observed': 'observé',
  'lead': 'échéance',
  'area': 'zone',
  'bias': 'biais',
  'spread': 'dispersion',
  'coverage': 'couverture',
  'Source bulletin': 'Bulletin source',
  'Emulated bulletin': 'Bulletin simulé',
  'Emulated bulletin. Do not use for a real passage decision.': 'Bulletin simulé. Ne l’utilisez pas pour prendre une décision de traversée réelle.',
  'Inspect emulated bulletin': 'Examiner le bulletin simulé',
  'Models and coverage': 'Modèles et couverture',
  'Check a passage to record its models and coverage.': 'Évaluez une traversée pour enregistrer ses modèles et sa couverture.',
  'Open briefing': 'Briefing ouvert',
  'Recorded models': 'Modèles enregistrés',
  'Recorded coverage': 'Couverture enregistrée',
  'Model records unavailable for this briefing.': 'Les modèles utilisés ne sont pas enregistrés dans ce briefing.',
  'Coverage records unavailable for this briefing.': 'La couverture évaluée n’est pas enregistrée dans ce briefing.',
  'Wind and gusts': 'Vent et rafales',
  'Ensemble': 'Ensemble',
  'Additional weather model': 'Modèle météo complémentaire',
  'Surface currents': 'Courants de surface',
  'Forecast tiles': 'Tuiles de prévision',
  'Fixture data': 'Données de test',
  'Source not recorded': 'Source non enregistrée',
  'Marine bulletin': 'Bulletin marine',
  'Close bulletin': 'Fermer le bulletin',
  'Issued': 'Émis',
  'Valid': 'Valide',
  'Zones': 'Zones',
  'Start': 'Départ',
  'Finish': 'Arrivée',
  'dep': 'départ',
  'cause': 'cause',
  'interception': 'rencontre',
  'consequence': 'conséquence',
  'easing': 'amélioration',
  'Wind against current': 'Vent contre courant',
  'what sets this up': 'ce qui met en place cette situation',
  'while you are out there': 'pendant votre traversée',
  'right after your passage': 'juste après votre traversée',
  'easing off': 'en amélioration',
  'A weather system crosses your passage window': 'Un système météo traverse votre fenêtre de passage',
  'A low-pressure system crosses your passage window': 'Une dépression traverse votre fenêtre de passage',
  'A deepening low crosses your passage window': 'Une dépression qui se creuse traverse votre fenêtre de passage',
  'A high-pressure ridge crosses your passage window': 'Une dorsale anticyclonique traverse votre fenêtre de passage',
  'A weather front crosses your passage window': 'Un front traverse votre fenêtre de passage',
  'Why this assessment': 'Pourquoi cette évaluation',
  'Strongest': 'Conditions les plus fortes',
  'around': 'vers',
  'professional register': 'registre professionnel',
  'No analysis open.': 'Aucune analyse ouverte.',
  'Choose a snapshot': 'Choisir un briefing',
  'fine': 'dans les limites',
  'close to your limits': 'proche de vos limites',
  'beyond your limits': 'au-delà de vos limites',
  'the limit you set': 'la limite que vous avez fixée',
  'models split': 'divergence des modèles',
  'wind over tide': 'vent contre courant',
  'gate closed': 'porte fermée',
  'gate tight': 'porte difficile',
  'warning': 'alerte',
  'squalls?': 'grains ?',
  'leg': 'tronçon',
  'run': 'cycle',
  'age': 'âge',
  'models in agreement across this passage': 'modèles concordants sur toute la traversée',
  'Global models under-resolve coastal wind acceleration, harbours and tidal races. Ocean-model currents are not tidal stream predictions.': 'Les modèles globaux représentent mal l’accélération côtière du vent, les ports et les raz de marée. Les courants des modèles océaniques ne sont pas des prévisions de courants de marée.',
  'synoptic situation': 'situation synoptique',
  'no attributed system': 'aucun système attribué',
  'system': 'système',
  'boat': 'bateau',
  'Synoptic pressure chart': 'Carte de pression synoptique',
  'track and route occupancy': 'trajectoire et occupation de la route',
  'Find a departure that fits': 'Trouver un départ adapté',
  'Open official bulletin': 'Ouvrir le bulletin officiel',
  'does not fit this departure': 'ne convient pas à ce départ',
  'only partly fits': 'ne convient que partiellement',
  'stream will be against you.': 'le courant vous sera contraire.',
  'Not assessed:': 'Non évalué :',
  'No flag does not mean no risk.': 'L’absence de signalement ne signifie pas l’absence de risque.',
  'Coverage derived conservatively from evidence in this legacy snapshot.': 'Couverture déduite avec prudence des éléments probants de cet ancien briefing.',
  'assessed': 'évalué',
  'assessed emulated': 'évalué (simulé)',
  'Evidence inspector': 'Inspecteur des éléments probants',
  'Close inspector': 'Fermer l’inspecteur',
  'Leg & window': 'Tronçon et fenêtre',
  'Legs': 'Tronçons',
  'Data source': 'Source des données',
  'Model run': 'Cycle du modèle',
  'Source age': 'Âge de la source',
  'Value vs declared limit': 'Valeur et limite déclarée',
  'not applicable': 'sans objet',
  'scenario': 'scénario',
  'Low': 'Dépression',
  'Zoom in': 'Zoom avant',
  'Zoom out': 'Zoom arrière',
  'Agreement is not proof. Models share observations and assumptions; disagreement mainly says when to wait for the next run.': 'L’accord ne constitue pas une preuve. Les modèles partagent des observations et des hypothèses ; leur divergence indique surtout quand attendre le prochain cycle.',
  'The weather system driving this': 'Le système météo à l’origine de la situation',
  'Route impact, leg by leg': 'Effet sur la route, tronçon par tronçon',
  'What the forecast means for each stretch of your passage:': 'Ce que la prévision implique pour chaque tronçon de votre traversée :',
  'Against your declared limits': 'Par rapport à vos limites déclarées',
  'What could change': 'Ce qui pourrait changer',
  'Not assessed by this analysis': 'Non évalué par cette analyse',
  'Emulated data in this analysis': 'Données simulées dans cette analyse',
  'Some values in this briefing come from EMULATED (synthetic) data sources, marked with a badge. Do not use them for a real passage decision.': 'Certaines valeurs de ce briefing proviennent de sources de données SIMULÉES (synthétiques), signalées par un badge. Ne les utilisez pas pour prendre une décision de traversée réelle.',
  'sustained wind': 'vent moyen',
  'visibility and convection': 'visibilité et convection',
  'model agreement': 'concordance des modèles',
  'tidal currents': 'courants de marée',
  'tidal gates': 'portes de marée',
  'official warnings': 'alertes officielles',
  'synoptic attribution': 'attribution synoptique',
  'tropical systems': 'systèmes tropicaux',
  'ice': 'glace',
  'partially assessed': 'partiellement évalué',
  'Claim-level evidence': 'Éléments probants au niveau de l’affirmation',
  'Evidence claims': 'Affirmations étayées',
  'of': 'sur',
  'over': 'au-dessus',
  'exceedance window': 'fenêtre de dépassement',
  '10 m sustained': 'vent moyen à 10 m',
  'live': 'direct',
  'gust': 'rafale',
  'ensemble': 'ensemble',
  'forecast scenarios': 'scénarios de prévision',
  'ETA window': 'fenêtre d’arrivée estimée',
  'model run': 'cycle du modèle',
  'veer': 'adonnante',
  'significant wave height': 'hauteur significative des vagues',
  'steepness': 'cambrure',
  'The same model run ~30 times with slightly different starting conditions (31 members for GEFS). The spread between members shows how uncertain the forecast is.': 'Le même modèle est exécuté environ 30 fois avec des conditions initiales légèrement différentes (31 membres pour GEFS). La dispersion entre les membres montre l’incertitude de la prévision.',
  'Your arrival time is a range, not an instant: computed for your slow, usual and fast boat speeds. Conditions are checked across the whole window.': 'Votre heure d’arrivée est une plage, pas un instant : elle est calculée pour les vitesses lente, habituelle et rapide de votre bateau. Les conditions sont vérifiées sur toute la fenêtre.',
  'Wind direction turning clockwise (e.g. SW → NW). Common behind a cold front.': 'Rotation du vent dans le sens horaire (p. ex. SO → NO). Fréquente derrière un front froid.',
  'The average of the highest third of waves. Individual waves can be nearly twice this height.': 'La moyenne du tiers des vagues les plus hautes. Certaines vagues peuvent atteindre près du double de cette hauteur.',
  'Wave height relative to wavelength. Steep waves break; short, steep seas are dangerous well below your height limit.': 'Rapport entre la hauteur et la longueur d’onde. Les vagues cambrées déferlent ; une mer courte et abrupte est dangereuse bien avant votre limite de hauteur.',
  // Current glossary wording (viewer/src/lib/glossary.jsx).
  'A brief burst above the sustained wind. Gusts are often 20–40% stronger; squalls can double it.': 'Une brève pointe au-dessus du vent moyen. Les rafales sont souvent 20 à 40 % plus fortes ; les grains peuvent la doubler.',
  'The ensemble members. "24 of 31 scenarios exceed your limit" is a raw count, not a calibrated probability. The total comes from the current run.': 'Les membres de l’ensemble. « 24 scénarios sur 31 dépassent votre limite » est un décompte brut, pas une probabilité étalonnée. Le total provient du cycle en cours.',
  'Weather models restart from fresh observations every 6–12 h. A new run can shift the forecast, so recheck before departure.': 'Les modèles météo redémarrent à partir de nouvelles observations toutes les 6 à 12 h. Un nouveau cycle peut décaler la prévision ; vérifiez à nouveau avant le départ.',
  'Wind against the tidal stream makes waves shorter and steeper. The Alderney Race is a well-known example.': 'Le vent contre le courant de marée rend les vagues plus courtes et plus abruptes. Le raz Blanchard en est un exemple bien connu.',
  'A passage best crossed in fair or slack stream. Miss the window and you meet foul current, rougher seas, or both.': 'Un passage à franchir de préférence par courant favorable ou à l’étale. Si vous manquez la fenêtre, vous affrontez un courant contraire, une mer plus dure, ou les deux.',
  // Briefing page — synoptic fallback, story bullets, decision band chrome.
  'No synoptic chart was archived with this briefing, so here is your passage chart. New briefings show the pressure pattern behind your forecast.': 'Aucune carte synoptique n’a été archivée avec ce briefing, voici donc votre carte de traversée. Les nouveaux briefings montrent la configuration de pression derrière votre prévision.',
  'The': 'La',
  'Bulletin text not archived for this legacy snapshot. Use the source and validity details above to find the authority record.': 'Texte du bulletin non archivé pour cet ancien briefing. Utilisez la source et les informations de validité ci-dessus pour retrouver le document officiel.',
  'The national weather service has an active marine warning for part of your route. Read the official bulletin first.': 'Le service météorologique national a émis une alerte marine active pour une partie de votre route. Lisez d’abord le bulletin officiel.',
  // Boat picker.
  'Type a model, for example First 36.7 or JPK 10.10': 'Saisissez un modèle, par exemple First 36.7 ou JPK 10.10',
  'No ORC boat matches “': 'Aucun bateau ORC ne correspond à «',
  '”. Choose a generic cruiser by length below. The briefing will identify the generic polar.': '». Choisissez un croiseur générique selon la longueur ci-dessous. Le briefing identifiera la polaire générique.',
  'boat types from the ORC 2025 database. Start typing to search.': 'modèles de bateaux dans la base ORC 2025. Commencez à taper pour rechercher.',
  // Planner errors, departure comparison and models-used panel.
  'No limits profile available. Open My limits first.': 'Aucun profil de limites disponible. Ouvrez d’abord Mes limites.',
  'Enter a valid departure date and 24-hour time.': 'Saisissez une date de départ valide et une heure au format 24 heures.',
  'None of the candidate departures could be assessed.': 'Aucun des départs candidats n’a pu être évalué.',
  'Unassessed departures': 'Départs non évalués',
  'A missing cell does not mean safe conditions.': 'Une case manquante ne signifie pas des conditions sûres.',
  'Unknown error': 'Erreur inconnue',
  '◎ Least exposure this window:': '◎ Exposition minimale sur cette fenêtre :',
  'Click a time to check that departure against your limits': 'Cliquez sur une heure pour vérifier ce départ selon vos limites',
  '(it sails its own computed route)': '(il suit sa propre route calculée)',
  '— the full briefing opens straight away.': '— le briefing complet s’ouvre directement.',
  'The models disagree near your limits throughout this window. Open a briefing to see where they diverge and when the next update is due.': 'Les modèles divergent près de vos limites sur toute cette fenêtre. Ouvrez un briefing pour voir où ils divergent et quand la prochaine mise à jour est attendue.',
  'not': 'pas',
  // Changes page and change ledger vocabulary.
  'Change ledger error:': 'Erreur du registre des évolutions :',
  'Full change ledger ·': 'Registre complet des évolutions ·',
  'entries': 'entrées',
  'material change': 'changement significatif',
  'previous ·': 'précédente ·',
  'latest ·': 'dernière ·',
  'the verdict changed': 'le verdict a changé',
  'timing shifted': 'chronologie décalée',
  'strength changed': 'intensité modifiée',
  'new signal': 'nouveau signal',
  'signal cleared': 'signal levé',
  'newer model run': 'nouveau cycle du modèle',
  'change': 'évolution',
  'within your limits': 'dans vos limites',
  'too uncertain to assess': 'trop incertain pour être évalué',
  'official warning active': 'alerte officielle active',
  'The action threshold changed; reassess the departure.': 'Le seuil d’action a changé ; réévaluez le départ.',
  'Authority coverage changed for a crossed marine zone.': 'La couverture officielle a changé pour une zone marine traversée.',
  'This is the rule currently driving the personal-limit assessment.': 'C’est la règle qui détermine actuellement l’évaluation selon vos limites.',
  'The hazardous interval moved relative to the route ETA envelope.': 'L’intervalle dangereux s’est déplacé par rapport à la fenêtre d’arrivée estimée.',
  'This remains in the full ledger because it may matter to passage margins.': 'Cette entrée reste dans le registre complet car elle peut influer sur les marges de la traversée.',
  // Snapshots page and chart labels.
  'manifest error:': 'erreur de manifeste :',
  'NOW': 'MAINTENANT',
};

const FR_PATTERNS = [
  [/^(This analysis|OBSERVATION SOURCE)( ·.*)$/, (_match, label, suffix) => `${FR[label]}${suffix}`],
  [/^(reading deterministic forecast tiles|checking ensemble tiles|reading wave tiles|reading hazard and model-comparison tiles)(…)?$/, (_match, label, ellipsis = '') => `${FR[label]}${ellipsis}`],
  [/^reading (\d+)-member ensemble tiles(…)?$/, (_match, members, ellipsis = '') => `lecture des tuiles d’ensemble à ${members} membres${ellipsis}`],
  [/^No route found within (\d+) h \(wind coverage, land, or no-go conditions\)$/, 'Aucune route trouvée en $1 h (couverture du vent, terre ou conditions impraticables)'],
  [/^Forecast grid coarsened to ([\d.]+)° to keep this crossing within the browser point budget\.$/, 'Grille de prévision ramenée à $1° pour respecter le nombre de points gérable par le navigateur pour cette traversée.'],
  [/^Route save failed: HTTP (\d+)$/, 'Échec de l’enregistrement de la route : HTTP $1'],
  [/^Snapshot write failed: HTTP (\d+)$/, 'Échec de l’enregistrement du briefing : HTTP $1'],
  [/^Snapshot (\S+) already exists \(write-once\)$/, 'Le briefing $1 existe déjà (écriture unique)'],
  [/^(.+): not stored with this briefing$/, '$1 : non enregistré avec ce briefing'],
  [/^Ensemble \(.+\): .+\.$/, (value) => translateProfessionalLegSuffix(` ${value}`).trim()],
  [/^Models diverge on \d+ h of this leg .+\.$/, (value) => translateProfessionalLegSuffix(` ${value}`).trim()],
  [/^Driver: .+\.$/, (value) => translateProfessionalDecisionSuffix(` ${value}`).trim()],
  [/^The main signal: .+\.$/, (value) => translateMainSignal(` ${value}`).trim()],
  [/^(All \d+|\d+ of \d+) forecast scenarios exceed your [\d.]+ kt (gust|wind) limit around .+ UTC\.$/, (value) => translateExceedanceSuffix(` ${value}`).trim()],
  [/^Unassessed hazard classes: ([^.]+)\.$/, (_match, capabilities) => `Catégories de dangers non évaluées : ${translateCapabilityList(capabilities)}.`],
  [/^Partial capability coverage: (.+)\.$/, (_match, capabilities) => `Couverture partielle des capacités : ${translateCapabilityList(capabilities)}.`],
  [/^(reading forecast run manifest|evaluating against your limits|reading current tiles|loading coastline|loading forecast tiles|loading current tiles|loading prepared data|saving immutable snapshot|starting|computing route|scanning departures)( \d+\/\d+)?(…)?$/, (_match, label, count = '', ellipsis = '') => `${FR[label]}${count}${ellipsis}`],
  [/^(· )?(\d+) h old$/, (_match, separator = '', hours) => `${separator}il y a ${hours} h`],
  [/^Seas to ([\d.]+) m significant \(deterministic wave model; no wave ensembles exist\)\.$/, 'Mer significative jusqu’à $1 m (modèle de vagues déterministe ; aucun ensemble de vagues).'],
  [/^Authority override: bulletin (.+) active during the passage window\.$/, 'Priorité à l’autorité : le bulletin $1 est actif pendant la fenêtre de traversée.'],
  [/^Emulated evidence entries: ([^.]+)\.$/, 'Entrées probantes simulées : $1.'],
  [/^Low (L\d+) intersects the Casquets and mid-Channel legs\.$/, 'La dépression $1 traverse les tronçons des Casquets et du milieu de la Manche.'],
  [/^Previous synoptic chart$/, 'Carte synoptique précédente'],
  [/^Latest synoptic chart$/, 'Dernière carte synoptique'],
  [/^Route (.+) has no speeds_kt\. Provide speeds for the slow, nominal and fast scenarios before running the passage audit\.$/, 'La route $1 ne contient pas de vitesses (speeds_kt). Renseignez les vitesses lente, nominale et rapide avant de lancer l’analyse de la traversée.', true],
  [/^Boat polar “(.+)” not found\. Regenerate and publish the ORC polar database\.$/, 'Polaire du bateau « $1 » introuvable. Régénérez et publiez la base de polaires ORC.'],
  [/^(\d+) members$/, '$1 membres'],
  [/^The next forecast update is estimated around (.+) UTC\. Check again then, especially if conditions are close to your limits\.$/, 'La prochaine mise à jour des prévisions est estimée vers $1 UTC. Vérifiez à nouveau à ce moment-là, surtout si les conditions approchent vos limites.'],
  [/^Next forecast update estimated around (.+) UTC\. Check again before departure\.$/, 'Prochaine mise à jour des prévisions estimée vers $1 UTC. Vérifiez à nouveau avant le départ.'],
  [/^Next forecast update time unavailable\. Check the published forecast before departure\.$/, 'Heure de la prochaine mise à jour indisponible. Consultez la prévision publiée avant le départ.'],
  [/^Estimated next (.+) publication ~(.+), using the loaded cycle, publication lag and tile-pipeline cadence\. Publication may be delayed\. Agreement between runs is not proof of accuracy\.$/, 'Prochaine publication de $1 estimée vers $2, à partir du cycle chargé, du délai de publication et de la cadence de la chaîne de tuiles. La publication peut être retardée. La concordance entre les cycles ne prouve pas leur exactitude.'],
  [/^No future publication estimate is available from the loaded forecast metadata and known tile-pipeline schedules\. Synthetic runs have no scheduled update\.$/, 'Les métadonnées des prévisions chargées et les calendriers connus de la chaîne de tuiles ne permettent pas d’estimer une prochaine publication. Les cycles synthétiques n’ont aucune mise à jour programmée.'],
  [/^A (strengthening )?low-pressure system sits (near the centre of your route|at the charted position|(?:within 100 nm|100–300 nm|more than 300 nm) [NSEW]+ of the centre of your route)\.$/, (_match, strengthening, position) => `Une dépression${strengthening ? ' qui se renforce' : ''} se trouve ${translateSynopticPosition(position)}.`],
  [/^A (strengthening )?low-pressure system sits (.+); that is what sets the wind pattern over your route\. The chart panels show how it moves over the next days\.$/, (_match, strengthening, position) => `Une dépression${strengthening ? ' qui se renforce' : ''} se trouve ${translateSynopticPosition(position)}; elle détermine le régime de vent sur votre route. Les cartes montrent son déplacement au cours des prochains jours.`],
  [/^A (strengthening )?low-pressure system sits (.+)\. It sets the wind pattern over your route\. The charts track it over the next few days\.$/, (_match, strengthening, position) => `Une dépression${strengthening ? ' qui se renforce' : ''} se trouve ${translateSynopticPosition(position)}. Elle détermine le régime de vent sur votre route. Les cartes suivent son déplacement au cours des prochains jours.`],
  [/^A (strengthening )?low-pressure system sits ((?:far out in the Atlantic|west of the approaches|near your waters), (?:to the north|to the south|at your latitude))\.$/, (_match, strengthening, position) => `Une dépression${strengthening ? ' qui se renforce' : ''} se trouve ${translateSynopticPosition(position)}.`],
  [/^T\+(\d+): (.+?)\.( Tighter isobar spacing over (.+) means stronger wind there\.)?$/, (_match, step, body, tail, region) => translateSynopticCaption(step, body, tail ? region : null)],
  [/^((?:A|An) [a-z-]+(?:[a-z -]*?) crosses your route\. )?(winds|gusts|seas|wind against the tide|squall risk|visibility|conditions) reach ([\d.]+) (kt|m|nm) (.+?), (close to|over) your ([\d.]+) (kt|m|nm) limit\.$/i, (_match, prefix, hazard, value, units, where, relation, limit, limitUnits) => translateDriverClause(prefix, hazard, value, units, where, relation, limit, limitUnits)],
  [/^((?:A|An) [a-z-]+(?:[a-z -]*?) crosses your route\. )?(every forecast scenario shows|most forecast scenarios show|\d+ of \d+ forecast scenarios show) (winds|gusts|seas|wind against the tide|squall risk|visibility|conditions) over your ([\d.]+) kt limit (.+?)\.$/i, (_match, prefix, share, hazard, limit, where) => translateScenarioClause(prefix, share, hazard, limit, where)],
  [/^next forecast ~(.+) · recheck before departure$/, 'prochaine prévision vers $1 · revérifiez avant le départ'],
  [/^near waypoint (\d+)$/, 'près du point de route $1'],
  [/^This run has no causal attribution\. Reason: (.+)\.$/, (_match, reason) => `Cette analyse ne comporte pas d’attribution causale. Raison : ${translateAttributionReason(reason)}.`],
  [/^(.+) gate$/, 'porte $1'],
  [/^YOUR LIMIT · ([\d.]+) (kt|m)$/, (_match, value, units) => `VOTRE LIMITE · ${value} ${units === 'kt' ? 'nd' : units}`],
  [/^forecast fetch failed: HTTP (\d+) for (.+)$/, 'Échec du chargement des prévisions : HTTP $1 pour $2'],
  [/^forecast fetch timed out after (\d+) ms for (.+)$/, 'Délai de chargement des prévisions dépassé après $1 ms pour $2'],
  [/^forecast fetch failed: network error for (.+)$/, 'Échec du chargement des prévisions : erreur réseau pour $1'],
  [/^forecast tile invalid: (.+) \(checksum mismatch\)$/, 'Tuile de prévision invalide : $1 (somme de contrôle incorrecte)'],
  [/^forecast tile invalid: (.+) \(decode failed\)$/, 'Tuile de prévision invalide : $1 (échec du décodage)'],
  [/^forecast tile fetch failed: HTTP (\d+) for (.+)$/, 'Échec du chargement d’une tuile de prévision : HTTP $1 pour $2'],
  [/^(\d+) of (\d+) departure times could not be assessed and are not shown\.$/, (_match, hidden, total) => `${hidden} sur ${total} heures de départ n’ont pas pu être évaluées et ne sont pas affichées.`],
  [/^(\d+) of (\d+) departure times fall beyond the (live forecast|forecast) horizon and are not shown\. A missing cell does not mean safe conditions\.$/, (_match, hidden, total, kind) => `${hidden} sur ${total} heures de départ sont au-delà de l’horizon de ${kind === 'live forecast' ? 'la prévision en direct' : 'prévision'} et ne sont pas affichées. Une case manquante ne signifie pas des conditions sûres.`],
  [/^Delete the briefing "(.+)" departing (.+) local time \((.+)\)\? This cannot be undone\.$/, 'Supprimer le briefing « $1 » partant $2 heure locale ($3) ? Cette action est irréversible.'],
  // Change-ledger entries (engine diff.ts descriptions and headlines).
  [/^Assessment changed: (.+) → (.+)\.$/, (_match, from, to) => `Évaluation modifiée : ${translateVerdictLabel(from)} → ${translateVerdictLabel(to)}.`],
  [/^New signal: (.+?)( around (.+) UTC)?\.$/, (_match, phrase, _tail, time) => `Nouveau signal : ${translateChangePhrase(phrase)}${time ? ` vers ${time} UTC` : ''}.`],
  [/^(.+): (\w{3} \d+ \w{3} \d{2}:\d{2}) → (\w{3} \d+ \w{3} \d{2}:\d{2}) UTC \((\d+) h (later|earlier)\)\.$/, (_match, phrase, prev, next, hours, direction) => `${translateChangePhrase(phrase)} : ${prev} → ${next} UTC (${hours} h ${direction === 'later' ? 'plus tard' : 'plus tôt'}).`],
  [/^(.+): (-?\d+) → (-?\d+) ?(\S*) \((up|down) (\d+)\)\.$/, (_match, phrase, prev, next, units, direction, delta) => `${translateChangePhrase(phrase)} : ${prev} → ${next}${units ? ` ${units === 'kt' ? 'nd' : units}` : ''} (${direction === 'up' ? 'en hausse' : 'en baisse'} de ${delta}).`],
  [/^(.+): (\d+) of (\d+) → (\d+) of (\d+) scenarios exceed\.$/, (_match, phrase, a, b, c, d) => `${translateChangePhrase(phrase)} : ${a} sur ${b} → ${c} sur ${d} scénarios en dépassement.`],
  [/^(.+) no longer flagged\.$/, (_match, phrase) => `${translateChangePhrase(phrase)} n’est plus signalé.`],
  [/^(.+) is the same system as in the previous briefing\. It now reaches the route (\d+) h (earlier|later)\.$/, (_match, name, hours, direction) => `${name} est le même système que dans le briefing précédent. Il atteint désormais la route ${hours} h ${direction === 'earlier' ? 'plus tôt' : 'plus tard'}.`],
  [/^Model run updated: (.+) → (.+)\.$/, 'Cycle du modèle mis à jour : $1 → $2.'],
  [/^The verdict changed from “(.+)” to “(.+)”\.$/, (_match, from, to) => `Le verdict est passé de « ${translateVerdictLabel(from)} » à « ${translateVerdictLabel(to)} ».`],
  [/^The verdict is still “(.+)”, but the timing or strength changed\.$/, (_match, state) => `Le verdict reste « ${translateVerdictLabel(state)} », mais la chronologie ou l’intensité a changé.`],
  [/^The new run keeps the same verdict: (.+)\.$/, (_match, state) => `Le nouveau cycle conserve le même verdict : ${translateVerdictLabel(state)}.`],
  [/^The assessment remains (.+), with updated detail\.$/, (_match, state) => `L’évaluation reste ${translateVerdictLabel(state)}, avec des détails mis à jour.`],
  [/^Low (L\d+) deepens west of the route\.$/, 'La dépression $1 se creuse à l’ouest de la route.'],
  [/^(.+): (light|moderate|fresh|strong|near-gale|gale-force) winds while you are on this stretch \((.+) UTC\)\.(.*)$/, (_match, leg, strength, window, suffix) => `${translateRouteName(leg)} : ${translateWindStrength(strength)} pendant ce tronçon (${window} UTC).${translateExceedanceSuffix(suffix)}`],
  [/^The forecasts disagree too much to assess this passage against your limits\. Reassess after the next model run\.(.*)$/, (_match, suffix) => `Les prévisions divergent trop pour évaluer cette traversée par rapport à vos limites. Réévaluez-la après le prochain cycle du modèle.${translateMainSignal(suffix)}`],
  [/^An official marine warning covers part of your route\. That takes precedence over everything below\.(.*)$/, (_match, suffix) => `Une alerte marine officielle couvre une partie de votre route. Elle prévaut sur tout ce qui suit.${translateMainSignal(suffix)}`],
  [/^Forecast conditions stay inside the limits you declared for this departure\.(.*)$/, (_match, suffix) => `Les conditions prévues restent dans les limites que vous avez déclarées pour ce départ.${translateMainSignal(suffix)}`],
  [/^Forecast conditions come close to the limits you declared\. Look at what is driving this before deciding\.(.*)$/, (_match, suffix) => `Les conditions prévues approchent des limites que vous avez déclarées. Examinez la cause avant de décider.${translateMainSignal(suffix)}`],
  [/^Forecast conditions go beyond the limits you declared for this departure\.(.*)$/, (_match, suffix) => `Les conditions prévues dépassent les limites que vous avez déclarées pour ce départ.${translateMainSignal(suffix)}`],
  [/^Authority override: bulletin (.+) active during the passage window\. This state overrides the personal-limit summary and does not assert a numeric limit exceedance\.$/, 'Priorité à l’autorité : le bulletin $1 est actif pendant la fenêtre de traversée. Cet état prévaut sur le résumé des limites personnelles et n’affirme aucun dépassement chiffré.'],
  [/^Detected systems \((.+)\): (.+)\. Front-type labels withheld pending corroboration \(§4\.1\)\.$/, (_match, run, systems) => `Systèmes détectés (${run}) : ${translateDetectedSystems(systems)}. Les types de fronts ne sont pas indiqués dans l’attente d’une corroboration (§4.1).`],
  [/^Per-leg conditions evaluated hourly across each leg's ETA occupancy window \(slow\/nominal\/fast scenarios\), course-relative\.$/, 'Conditions de chaque tronçon évaluées heure par heure sur sa fenêtre d’occupation estimée (scénarios lent, nominal et rapide), par rapport à la route.'],
  [/^L\d+ .+ \([\d.]+ nm, [\d.]+°T\): .+$/, (value) => translateProfessionalLeg(value)],
  [/^(All evaluated condition-hours remain below declared thresholds|One or more condition-hours reach ≥75% of a declared limit, or the ensemble scenario fraction is above your declared floor|At least one condition-hour exceeds a declared threshold in the deterministic run|Deterministic model divergence exceeds assessment tolerance within the passage window|Authority override active: an official bulletin covers route zones during the passage window)\.(.*)$/, (_match, assessment, suffix) => `${translateProfessionalAssessment(assessment)}.${translateProfessionalDecisionSuffix(suffix)}`],
  [/^Next (.+) cycle expected ~(.+)\. Model run ids in this analysis are inferred from publication schedules until the prepared-run pipeline provides authoritative cycles\. Agreement between runs is not proof of accuracy\.$/, 'Prochain cycle $1 attendu vers $2. Dans cette analyse, les identifiants de cycles sont déduits des calendriers de publication jusqu’à ce que la chaîne de préparation fournisse les cycles de référence. La concordance entre les cycles ne prouve pas leur exactitude.'],
  [/^Emulated evidence entries: (.+)\. Provider modes are recorded in the snapshot inputs\.$/, 'Entrées probantes simulées : $1. Les modes des fournisseurs sont consignés dans les données d’entrée du briefing.'],
  [/^This briefing does NOT cover: (.+)\. Partly assessed: (.+)\. No warning here does not mean no risk\.$/, (_match, unsupported, partial) => `Ce briefing ne couvre PAS : ${translateCapabilityList(unsupported)}. Évaluation partielle : ${translateCapabilityList(partial)}. L’absence d’alerte ici ne signifie pas l’absence de risque.`],
  [/^This briefing does NOT cover: (.+)\. No warning here does not mean no risk\.$/, (_match, unsupported) => `Ce briefing ne couvre PAS : ${translateCapabilityList(unsupported)}. L’absence d’alerte ici ne signifie pas l’absence de risque.`],
  [/^Unassessed hazard classes: (.+)\. Partial capability coverage: (.+)\. Absence of a flag must not be read as absence of risk \(brief §5\)\.$/, (_match, unsupported, partial) => `Catégories de dangers non évaluées : ${translateCapabilityList(unsupported)}. Couverture partielle des capacités : ${translateCapabilityList(partial)}. L’absence de signalement ne doit pas être interprétée comme une absence de risque (briefing §5).`],
  [/^Unassessed hazard classes: (.+)\. Absence of a flag must not be read as absence of risk \(brief §5\)\.$/, (_match, unsupported) => `Catégories de dangers non évaluées : ${translateCapabilityList(unsupported)}. L’absence de signalement ne doit pas être interprétée comme une absence de risque (briefing §5).`],
  [/^Plan views$/, 'Vues de planification'],
  [/^Brief views$/, 'Vues du briefing'],
  [/^Watch views$/, 'Vues du suivi'],
  [/^Verify views$/, 'Vues de vérification'],
  [/^SNAPSHOT$/, 'BRIEFING'],
  [/^SNAPSHOT /, 'BRIEFING '],
  [/^Start\s*→\s*Finish$/, 'Départ → Arrivée'],
  [/^24-hour clock \(HH:mm\) · your local time · (.+)$/, 'format 24 heures (HH:mm) · votre heure locale · $1'],
  [/^24-hour local time · (.+) · same route, different weather$/, 'heure locale au format 24 heures · $1 · même route, météo différente'],
  [/^24-hour local time · (.+) · each departure sails its own computed route$/, 'heure locale au format 24 heures · $1 · chaque départ suit sa propre route calculée'],
  [/^local time · (.+)$/, 'heure locale · $1'],
  [/^dep (.+) local time · (.+)$/, 'départ $1 heure locale · $2'],
  [/^dep (.+) UTC$/, 'départ $1 UTC'],
  [/^forecast updates ~(.+); check again before you cast off$/, 'mise à jour des prévisions vers $1; vérifiez à nouveau avant d’appareiller'],
  [/^The forecast updates around (.+); check again before you cast off\.$/, 'La prévision est mise à jour vers $1; vérifiez à nouveau avant d’appareiller.'],
  [/^The forecast updates several times a day\. Check again before you cast off\.$/, 'La prévision est mise à jour plusieurs fois par jour. Vérifiez à nouveau avant d’appareiller.'],
  [/^The next model run is expected around (.+) UTC\. Check again then, especially if conditions are close to your limits\.$/, 'Le prochain cycle du modèle est attendu vers $1 UTC. Vérifiez à nouveau à ce moment-là, surtout si les conditions approchent vos limites.'],
  [/^A weather system crosses your passage window$/, 'Un système météo traverse votre fenêtre de passage'],
  [/^The forecast reaches ([\d.]+) (\w+) against your ([\d.]+) (\w+) limit (.+)\.$/, 'La prévision atteint $1 $2, pour une limite fixée à $3 $4, $5.'],
  [/^Strongest (.+)$/, 'Conditions les plus fortes $1'],
  [/^Wind over tide (.+) around (.+) UTC; expect short, steep seas\.$/, 'Vent contre courant $1 vers $2 UTC; attendez-vous à une mer courte et abrupte.'],
  [/^Wind opposes the current at (.+), increasing the risk of short, steep seas\.$/, 'Le vent s’oppose au courant au $1, ce qui augmente le risque de mer courte et abrupte.'],
  [/^Wind opposes the current (.+), increasing the risk of short, steep seas\.$/, 'Le vent s’oppose au courant $1, ce qui augmente le risque de mer courte et abrupte.'],
  [/^models diverge on (\d+) h of this passage$/, 'les modèles divergent pendant $1 h sur cette traversée'],
  [/^run (.+) · age (.+)$/, 'cycle $1 · âge $2'],
  [/^system undefined · boat (.+)$/, 'aucun système attribué · bateau $1'],
  [/^system (.+) · boat (.+)$/, 'système $1 · bateau $2'],
  [/^leg (\d+): approaching$/, 'tronçon $1 : proche des limites'],
  [/^leg (\d+): exceeded$/, 'tronçon $1 : limite dépassée'],
  [/^leg (\d+): ok$/, 'tronçon $1 : dans les limites'],
  [/^Previous run: Low (.+) is weaker and six hours slower\.$/, 'Analyse précédente : la dépression $1 est moins intense et retardée de six heures.'],
  [/^Previous run: (.+)$/, 'Analyse précédente : $1'],
  [/^Low (.+) track and route occupancy$/, 'Trajectoire de la dépression $1 et occupation de la route'],
  [/^High (.+) track and route occupancy$/, 'Trajectoire de l’anticyclone $1 et occupation de la route'],
  [/^gusts up to ([\d.]+) kt; close to your ([\d.]+) kt limit while the low crosses (.+)\.$/, 'rafales jusqu’à $1 nd; proches de votre limite de $2 nd pendant que la dépression traverse $3.'],
  [/^gusts up to ([\d.]+) kt; over your ([\d.]+) kt limit while the low crosses (.+)\.$/, 'rafales jusqu’à $1 nd; au-dessus de votre limite de $2 nd pendant que la dépression traverse $3.'],
  [/^(.+): fresh winds while you are on this stretch \((.+)\)\.(.*)$/, '$1 : vents frais pendant ce tronçon ($2).$3'],
  [/^(.+): strong winds while you are on this stretch \((.+)\)\.(.*)$/, '$1 : vents forts pendant ce tronçon ($2).$3'],
  [/^(.+): light winds while you are on this stretch \((.+)\)\.(.*)$/, '$1 : vents faibles pendant ce tronçon ($2).$3'],
  [/^(.+): moderate winds while you are on this stretch \((.+)\)\.(.*)$/, '$1 : vents modérés pendant ce tronçon ($2).$3'],
  [/^Forecasts update several times a day\. Check again after the next model run \(expected around (.+) UTC\); especially if you are close to your limits\.$/, 'Les prévisions sont mises à jour plusieurs fois par jour. Vérifiez à nouveau après le prochain cycle du modèle (attendu vers $1 UTC), surtout si les conditions sont proches de vos limites.'],
  [/^Conditions along your route: (.+)$/, 'Conditions le long de votre route : $1'],
  [/^(\d+) of (\d+)$/, '$1 sur $2'],
  [/^forecast scenarios exceed (.+); raw fraction \((.+)\), not a calibrated probability$/, 'scénarios de prévision dépassent $1; fraction brute ($2), pas une probabilité étalonnée'],
  [/^All (\d+) forecast scenarios exceed your (.+) limit (.+)\.$/, 'Les $1 scénarios de prévision dépassent votre limite de $2 $3.'],
  [/^(\d+) of (\d+) forecast scenarios exceed your (.+) limit (.+)\.$/, '$1 scénarios sur $2 dépassent votre limite de $3 $4.'],
  [/^near (.+)$/, 'près de $1'],
  [/^at (.+)$/, 'à $1'],
  [/^waypoint (\d+)$/, 'point de route $1'],
  [/^T\+(\d+): low ([^(]+) \((\d+) hPa\) (.+), deepening ([^,]+), (.+)\.$/, 'T+$1 : dépression $2 ($3 hPa) $4, se creusant de $5, $6.'],
  [/^(\d+) waypoints$/, '$1 points de route'],
  [/^(\d+)\/2 endpoints$/, '$1/2 extrémités'],
  [/^departing (.+) UTC · made (.+)$/, 'départ $1 UTC · créé $2'],
  [/^(\d+) h old$/, 'il y a $1 h'],
  [/^(\d+) pass · (\d+) fail · (\d+) pending$/, (_match, pass, fail, pending) => `${pass} ${pass === '1' ? 'réussite' : 'réussites'} · ${fail} ${fail === '1' ? 'échec' : 'échecs'} · ${pending} en attente`],
  [/^Skill claims use (\d+) real ERA5 cases\.$/, 'Les mesures de fiabilité reposent sur $1 cas ERA5 réels.'],
  [/^1 emulated cases? shown for demo only\.$/, '1 cas simulé affiché uniquement pour la démonstration.'],
  [/^(\d+) emulated cases shown for demo only\.$/, '$1 cas simulés affichés uniquement pour la démonstration.'],
  [/^material change (\d+) · /, 'changement significatif $1 · '],
  [/^(.+) run$/, 'analyse $1'],
  [/^(.+) tracked positions$/, '$1 positions suivies'],
  [/^([\d.]+) nm$/, '$1 M'],
  [/^(≈?\d+) h passage$/, '$1 h de traversée'],
  [/^member (\d+)$/, 'membre $1'],
  [/^(\d+(?:\.\d+)?) nm · arrive$/, '$1 M · arrivée'],
  [/^Detected systems \((.+)\): (.+)\.$/, (_match, run, systems) => `Systèmes détectés (${run}) : ${translateDetectedSystems(systems)}.`],
  [/^This briefing does NOT cover: (.+)\.$/, (_match, capabilities) => `Ce briefing ne couvre PAS : ${translateCapabilityList(capabilities)}.`],
];

// Chart-caption grammar mirrors analysis/synoptic/render.py: system sentences
// joined by "; ", each "kind ID (P hPa) <place>, <trend>, <motion>".
const FR_PLACES = {
  'Iceland': 'l’Islande',
  'the Faroes': 'les Féroé',
  'Scotland': 'l’Écosse',
  'Ireland': 'l’Irlande',
  'west of Ireland': 'l’ouest de l’Irlande',
  'the Irish Sea': 'la mer d’Irlande',
  'the North Sea': 'la mer du Nord',
  'the western Channel': 'la Manche occidentale',
  'the eastern Channel': 'la Manche orientale',
  'Brittany': 'la Bretagne',
  'the Bay of Biscay': 'le golfe de Gascogne',
  'Iberia': 'la péninsule Ibérique',
  'the Azores': 'les Açores',
  'the Gulf of Lion': 'le golfe du Lion',
  'the Gulf of Genoa': 'le golfe de Gênes',
  'the mid-Atlantic': 'le milieu de l’Atlantique',
};

const FR_COMPASS8 = {
  'north': 'au nord', 'north-east': 'au nord-est', 'east': 'à l’est', 'south-east': 'au sud-est',
  'south': 'au sud', 'south-west': 'au sud-ouest', 'west': 'à l’ouest', 'north-west': 'au nord-ouest',
};

/** "de" + article-bearing place name, with the usual contractions. */
function frDe(placeFr) {
  if (placeFr.startsWith('le ')) return `du ${placeFr.slice(3)}`;
  if (placeFr.startsWith('les ')) return `des ${placeFr.slice(4)}`;
  if (placeFr.startsWith('la ') || placeFr.startsWith('l’')) return `de ${placeFr}`;
  return `de ${placeFr}`;
}

function translateCaptionPlace(place) {
  let match = place.match(/^over (.+)$/);
  if (match) return `sur ${FR_PLACES[match[1]] ?? match[1]}`;
  match = place.match(/^(north|north-east|east|south-east|south|south-west|west|north-west) of (.+)$/);
  if (match) return `${FR_COMPASS8[match[1]]} ${frDe(FR_PLACES[match[2]] ?? match[2])}`;
  match = place.match(/^near (.+)$/);
  if (match) return `près de ${match[1]}`;
  return place;
}

function translateCaptionSystem(sentence) {
  const match = sentence.match(/^(low|high) (\S+) \((\d+) hPa\) (.+?)((?:, [^,]+)*)$/);
  if (!match) return sentence;
  const kind = match[1] === 'low' ? 'dépression' : 'anticyclone';
  const rest = match[5]
    .replace(/, deepening ([\d.]+) hPa\/24h/g, ', se creusant de $1 hPa/24 h')
    .replace(/, filling ([\d.]+) hPa\/24h/g, ', se comblant de $1 hPa/24 h')
    .replace(/, building ([\d.]+) hPa\/24h/g, ', se renforçant de $1 hPa/24 h')
    .replace(/, declining ([\d.]+) hPa\/24h/g, ', s’affaiblissant de $1 hPa/24 h')
    .replace(/, steady/g, ', stable')
    .replace(/, quasi-stationary/g, ', quasi stationnaire')
    .replace(/, moving ([A-Z]+) (\d+) kt/g, (_m, dir, speed) => `, se déplaçant vers le ${dir.replace(/W/g, 'O')} à ${speed} nd`);
  return `${kind} ${match[2]} (${match[3]} hPa) ${translateCaptionPlace(match[4])}${rest}`;
}

function translateSynopticCaption(step, body, gradientRegion) {
  const bodyFr = body === 'no closed pressure centres in the window'
    ? 'aucun centre de pression fermé dans la fenêtre'
    : body.split('; ').map(translateCaptionSystem).join(' ; ');
  const tail = gradientRegion
    ? ` Le resserrement des isobares sur ${FR_PLACES[gradientRegion] ?? gradientRegion} y indique un vent plus fort.`
    : '';
  return `T+${step} : ${bodyFr}.${tail}`;
}

function translateAttributionReason(reason) {
  return {
    'the prepared synoptic run contains no tracked systems': 'le cycle synoptique préparé ne contient aucun système suivi',
    'no prepared synoptic run was supplied': 'aucun cycle synoptique préparé n’a été fourni',
  }[reason] ?? reason;
}

function translateChangePhrase(phrase) {
  let out = phrase;
  for (const [en, fr] of Object.entries(ruleSubjectTranslations)) {
    if (out.startsWith(en)) {
      out = fr + out.slice(en.length);
      break;
    }
  }
  return out
    .replace(/ near waypoint (\d+)$/, ' près du point de route $1')
    .replace(/ near (.+)$/, ' près de $1')
    .replace(/ on leg (\S+)$/, ' sur le tronçon $1')
    .replace(/ for zone (.+)$/, ' pour la zone $1')
    .replace(/ for the route$/, ' pour la route');
}

function translateVerdictLabel(label) {
  return {
    'within your limits': 'dans vos limites',
    'close to your limits': 'proche de vos limites',
    'beyond your limits': 'au-delà de vos limites',
    'too uncertain to assess': 'trop incertain pour être évalué',
    'official warning active': 'alerte officielle active',
  }[label] ?? label;
}

// Decision-band cause sentence (viewer pages/Briefing.jsx DecisionBand).
const FR_HAZARD_REACH = {
  'winds': 'Le vent atteint',
  'gusts': 'Les rafales atteignent',
  'seas': 'La mer atteint',
  'wind against the tide': 'Le vent contre le courant atteint',
  'squall risk': 'Le risque de grains atteint',
  'visibility': 'La visibilité atteint',
  'conditions': 'Les conditions atteignent',
};

const FR_HAZARD_NOUN = {
  'winds': 'du vent',
  'gusts': 'des rafales',
  'seas': 'une mer',
  'wind against the tide': 'du vent contre le courant',
  'squall risk': 'un risque de grains',
  'visibility': 'une visibilité',
  'conditions': 'des conditions',
};

const FR_UNITS = { kt: 'nd', m: 'm', nm: 'M' };

function translateEventPrefix(prefix) {
  if (!prefix) return '';
  return prefix
    .replace(/^A deepening low crosses your route\. $/, 'Une dépression qui se creuse traverse votre route. ')
    .replace(/^A low-pressure system crosses your route\. $/, 'Une dépression traverse votre route. ')
    .replace(/^A high-pressure ridge crosses your route\. $/, 'Une dorsale anticyclonique traverse votre route. ')
    .replace(/^A weather front crosses your route\. $/, 'Un front traverse votre route. ')
    .replace(/^A weather system crosses your route\. $/, 'Un système météo traverse votre route. ');
}

function translateDriverPlace(where) {
  const match = where.match(/^near (.+)$/i);
  if (!match) return where;
  const spot = match[1].match(/^waypoint (\d+)$/i);
  return spot ? `près du point de route ${spot[1]}` : `près de ${match[1]}`;
}

function translateDriverClause(prefix, hazard, value, units, where, relation, limit, limitUnits) {
  const subject = FR_HAZARD_REACH[hazard.toLowerCase()] ?? `${hazard} atteint`;
  const plural = hazard.toLowerCase() === 'gusts' || hazard.toLowerCase() === 'conditions';
  const relationFr = relation === 'over'
    ? `au-dessus de votre limite de ${limit} ${FR_UNITS[limitUnits] ?? limitUnits}`
    : `${plural ? 'proches' : 'proche'} de votre limite de ${limit} ${FR_UNITS[limitUnits] ?? limitUnits}`;
  const sentence = `${subject} ${value} ${FR_UNITS[units] ?? units} ${translateDriverPlace(where)}, ${relationFr}.`;
  return `${translateEventPrefix(prefix)}${sentence}`;
}

function translateScenarioClause(prefix, share, hazard, limit, where) {
  const shareMatch = share.match(/^(\d+) of (\d+) forecast scenarios show$/i);
  const shareFr = shareMatch
    ? `${shareMatch[1]} scénarios de prévision sur ${shareMatch[2]} montrent`
    : /^every/i.test(share)
      ? 'Tous les scénarios de prévision montrent'
      : 'La plupart des scénarios de prévision montrent';
  const sentence = `${shareFr} ${FR_HAZARD_NOUN[hazard.toLowerCase()] ?? hazard} au-dessus de votre limite de ${limit} nd ${translateDriverPlace(where)}.`;
  return `${translateEventPrefix(prefix)}${sentence}`;
}

function translateSynopticPosition(position) {
  if (position === 'near the centre of your route') return 'près du centre de votre route';
  if (position === 'at the charted position') return 'à la position indiquée sur la carte';
  const relative = position.match(/^(within 100 nm|100–300 nm|more than 300 nm) ([NSEW]+) of the centre of your route$/);
  if (relative) {
    const band = { 'within 100 nm': 'à moins de 100 M', '100–300 nm': 'à 100–300 M', 'more than 300 nm': 'à plus de 300 M' }[relative[1]];
    return `${band} ${relative[2].replaceAll('W', 'O')} du centre de votre route`;
  }
  const positions = {
    'far out in the Atlantic, to the north': 'loin dans l’Atlantique, au nord',
    'far out in the Atlantic, to the south': 'loin dans l’Atlantique, au sud',
    'far out in the Atlantic, at your latitude': 'loin dans l’Atlantique, à votre latitude',
    'west of the approaches, to the north': 'à l’ouest des approches, au nord',
    'west of the approaches, to the south': 'à l’ouest des approches, au sud',
    'west of the approaches, at your latitude': 'à l’ouest des approches, à votre latitude',
    'near your waters, to the north': 'près de votre zone de navigation, au nord',
    'near your waters, to the south': 'près de votre zone de navigation, au sud',
    'near your waters, at your latitude': 'près de votre zone de navigation, à votre latitude',
  };
  return positions[position] ?? position;
}

function translateDetectedSystems(systems) {
  return systems
    .replace(/^lows /, 'dépressions ')
    .replace(/; highs none/, ' ; aucun anticyclone')
    .replace(/; highs /, ' ; anticyclones ')
    .replace(/\bnone\b/g, 'aucun')
    .replace(/\bnear\b/g, 'près de')
    .replace(/, deepening ([\d.]+) hPa\/24h/g, ', se creusant de $1 hPa/24 h')
    .replace(/, filling ([\d.]+) hPa\/24h/g, ', se comblant de $1 hPa/24 h')
    .replace(/, steady/g, ', stable')
    .replace(/, moving ([A-Z]+) ([\d.]+) kt/g, ', se déplaçant vers l’$1 à $2 nd');
}

function translateRouteName(name) {
  return name
    .replace(/\bStart\b/g, 'Départ')
    .replace(/\bFinish\b/g, 'Arrivée')
    .replace(/\bwaypoint (\d+)\b/gi, 'point de route $1');
}

function translateWindStrength(strength) {
  return {
    light: 'vents faibles',
    moderate: 'vents modérés',
    fresh: 'vents frais',
    strong: 'vents forts',
    'near-gale': 'vents proches du grand frais',
    'gale-force': 'vents de force coup de vent',
  }[strength];
}

function translateExceedanceSuffix(suffix) {
  if (!suffix) return '';
  const match = suffix.match(/^ (all (\d+)|(\d+) of (\d+)) forecast scenarios exceed your ([\d.]+) kt (gust|wind) limit around (.+) UTC\.$/i);
  if (!match) return suffix;
  const count = match[2] ? `Les ${match[2]} scénarios de prévision` : `${match[3]} scénarios sur ${match[4]}`;
  const kind = match[6] === 'gust' ? 'rafales' : 'vent';
  return ` ${count} dépassent votre limite de ${kind} de ${match[5]} nd vers ${match[7]} UTC.`;
}

function translateProfessionalLeg(value) {
  const match = value.match(/^(L\d+) (.+) \(([\d.]+) nm, ([\d.]+)°T\): sustained ([\d–.]+) kt(?:, gusts to ([\d.]+) kt)? across the ETA window (.+) UTC\.(.*)$/);
  if (!match) return value;
  const translated = `${match[1]} ${translateRouteName(match[2])} (${match[3]} M, ${match[4]}° vrais) : vent moyen ${match[5]} nd${match[6] ? `, rafales jusqu’à ${match[6]} nd` : ''} sur la fenêtre d’arrivée estimée ${match[7]} UTC.`;
  return translated + translateProfessionalLegSuffix(match[8]);
}

function translateProfessionalLegSuffix(suffix) {
  return suffix
    .replace(/ Seas to ([\d.]+) m significant \(deterministic wave model; no wave ensembles exist\)\./g, ' Mer significative jusqu’à $1 m (modèle de vagues déterministe ; aucun ensemble de vagues).')
    .replace(/ Wind against swell here; expect steeper, more uncomfortable seas\./g, ' Vent contre houle sur ce tronçon : attendez-vous à une mer plus abrupte et inconfortable.')
    .replace(/ Wind-against-swell flagged\./g, ' Vent contre houle signalé.')
    .replace(/ Models diverge on (\d+) h of this leg \(max spread ([\d.]+) kt\); agreement is not proof, divergence says wait for the next run\./g, ' Les modèles divergent pendant $1 h sur ce tronçon (écart maximal de $2 nd) ; la concordance ne constitue pas une preuve et la divergence invite à attendre le prochain cycle.')
    .replace(/ Ensemble \((.+)\): all (\d+) forecast scenarios exceed your ([\d.]+) kt (gust|wind) limit at (.+) \(raw scenario fraction; not a calibrated probability\)\./gi, (_m, model, count, limit, kind, time) => ` Ensemble (${model}) : les ${count} scénarios de prévision dépassent votre limite de ${kind.toLowerCase() === 'gust' ? 'rafales' : 'vent'} de ${limit} nd à ${time} (fraction brute de scénarios, et non probabilité étalonnée).`)
    .replace(/ Ensemble \((.+)\): (\d+) of (\d+) forecast scenarios exceed your ([\d.]+) kt (gust|wind) limit at (.+) \(raw scenario fraction; not a calibrated probability\)\./gi, (_m, model, exceed, total, limit, kind, time) => ` Ensemble (${model}) : ${exceed} scénarios sur ${total} dépassent votre limite de ${kind.toLowerCase() === 'gust' ? 'rafales' : 'vent'} de ${limit} nd à ${time} (fraction brute de scénarios, et non probabilité étalonnée).`);
}

function translateProfessionalAssessment(assessment) {
  return {
    'All evaluated condition-hours remain below declared thresholds': 'Toutes les conditions horaires évaluées restent sous les seuils déclarés',
    'One or more condition-hours reach ≥75% of a declared limit, or the ensemble scenario fraction is above your declared floor': 'Une ou plusieurs conditions horaires atteignent au moins 75 % d’une limite déclarée, ou la fraction de scénarios d’ensemble dépasse votre seuil déclaré',
    'At least one condition-hour exceeds a declared threshold in the deterministic run': 'Au moins une condition horaire dépasse un seuil déclaré dans le cycle déterministe',
    'Deterministic model divergence exceeds assessment tolerance within the passage window': 'La divergence des modèles déterministes dépasse la tolérance d’évaluation pendant la fenêtre de traversée',
    'Authority override active: an official bulletin covers route zones during the passage window': 'Priorité active à l’autorité : un bulletin officiel couvre des zones de la route pendant la fenêtre de traversée',
  }[assessment];
}

function translateProfessionalDecisionSuffix(suffix) {
  return suffix
    .replace(/ Driver: (\S+) on (L\d+) at (\S+); (\d+)\/(\d+) members > ([\d.]+) (\S+)\./g, ' Facteur déterminant : $1 sur $2 à $3; $4 membres sur $5 > $6 $7.')
    .replace(/ Driver: (\S+) on (L\d+) at (\S+); ([\d.]+) (\S+) vs declared ([\d.]+) (\S+)\./g, ' Facteur déterminant : $1 sur $2 à $3; $4 $5 contre une limite déclarée de $6 $7.');
}

function translateMainSignal(suffix) {
  if (!suffix) return '';
  const match = suffix.match(/^ The main signal: (.+) on (.+) around (.+) UTC\.$/);
  if (!match) return suffix;
  return ` Signal principal : ${translateExceedanceClaim(match[1])} sur ${translateRouteName(match[2])} vers ${match[3]} UTC.`;
}

function translateExceedanceClaim(claim) {
  return claim
    .replace(/^gusts up to ([\d.]+) kt; over your ([\d.]+) kt limit$/, 'rafales jusqu’à $1 nd; au-dessus de votre limite de $2 nd')
    .replace(/^gusts up to ([\d.]+) kt; close to your ([\d.]+) kt limit$/, 'rafales jusqu’à $1 nd; proches de votre limite de $2 nd')
    .replace(/^([\d.]+) kt against your ([\d.]+) kt limit$/, '$1 nd pour une limite de $2 nd')
    .replace(/^(all (\d+)|(\d+) of (\d+)) forecast scenarios exceed your ([\d.]+) kt limit$/i, (_match, _count, all, exceed, total, limit) => all
      ? `les ${all} scénarios de prévision dépassent votre limite de ${limit} nd`
      : `${exceed} scénarios sur ${total} dépassent votre limite de ${limit} nd`);
}

function translateCapabilityList(value) {
  return value
    .replace(/causal synoptic attribution \(no prepared synoptic run\)/gi, 'attribution synoptique causale (aucune analyse synoptique préparée)')
    .replace(/official marine warnings \(no feed configured\)/gi, 'alertes marines officielles (aucun flux configuré)')
    .replace(/official marine warnings/gi, 'alertes marines officielles')
    .replace(/tidal currents & gates/gi, 'courants et portes de marée')
    .replace(/waves \(deterministic wave model only; no wave ensemble\)/gi, 'vagues (modèle de vagues déterministe uniquement ; aucun ensemble de vagues)')
    .replace(/visibility_and_convection \(screening signals only \(single model, GFS\); official warnings remain authoritative\)/gi, 'visibilité et convection (signaux de dépistage uniquement, issus d’un seul modèle, GFS ; les alertes officielles restent la référence)')
    .replace(/tidal_currents \(stride-subsampled x(\d+) from native ([\d.]+) deg to ([\d.]+) deg \(target ([\d.]+) deg\); values are exact native cell values, no smoothing\)/gi, 'courants de marée (sous-échantillonnage par pas x$1, de $2° natif à $3°, cible $4° ; valeurs exactes des cellules natives, sans lissage)')
    .replace(/tidal currents \(no prepared current grid\)/gi, 'courants de marée (aucune grille de courants préparée)')
    .replace(/tidal gates & HW\/LW heights \(no tide data\)/gi, 'portes de marée et hauteurs PM/BM (aucune donnée de marée)')
    .replace(/tropical systems/gi, 'systèmes tropicaux')
    .replace(/\bice\b/gi, 'glace')
    .replace(/limited inputs/gi, 'données d’entrée limitées');
}

const FR_FRAGMENTS = [
  [/The (.+?) gate does not fit this departure: you would reach it (.+?) UTC, outside the favorable stream \((.+?)\)\. Shifting departure may fix this\./g, 'La porte $1 ne convient pas à ce départ : vous l’atteindriez $2 UTC, hors du courant favorable ($3). Décaler le départ peut y remédier.'],
  [/The (.+?) gate only partly fits: aim for the (.+?)-referenced window \((.+?)\)\./g, 'La porte $1 ne convient que partiellement : visez la fenêtre référencée sur $2 ($3).'],
  [/Wind opposes the swell here, making the sea steeper and less comfortable\./g, 'Le vent s’oppose à la houle ici, rendant la mer plus cambrée et moins confortable.'],
  [/The stream will be against you\./g, 'Le courant vous sera contraire.'],
  [/\bExpect short, steep seas\b/g, 'Attendez-vous à une mer courte et abrupte'],
  [/\bYOUR LIMIT\b/g, 'VOTRE LIMITE'],
  [/\bofficial marine warnings \(no feed configured\)/gi, 'alertes marines officielles (aucun flux configuré)'],
  [/\bmoderate winds while you are on this stretch\b/gi, 'vents modérés pendant ce tronçon'],
  [/\bClaim-level evidence\b/g, 'Éléments probants au niveau de l’affirmation'],
  [/\bforecast scenarios exceed your\b/gi, 'scénarios de prévision dépassent votre'],
  [/\bEvidence claims\b/g, 'Affirmations étayées'],
  [/\bexceedance window\b/gi, 'fenêtre de dépassement'],
  [/\bYOUR limit\b/g, 'VOTRE limite'],
  [/\b10 m sustained\b/gi, 'vent moyen à 10 m'],
  [/\bPrevious run: Low (L\d+) is weaker and six hours slower\./g, 'Analyse précédente : la dépression $1 est moins intense et retardée de six heures.'],
  [/\bdeparting\b/gi, 'départ'],
  [/\bmade\b/gi, 'créé'],
  [/\bA low-pressure system crosses your passage window\b/g, 'Une dépression traverse votre fenêtre de passage'],
  [/\bA weather system crosses your passage window\b/g, 'Un système météo traverse votre fenêtre de passage'],
  [/\bPrevious run\b/gi, 'Analyse précédente'],
  [/\bLow (L\d+)\b/g, 'Dépression $1'],
  [/\bHigh (H\d+)\b/g, 'Anticyclone $1'],
  [/\btrack and route occupancy\b/gi, 'trajectoire et occupation de la route'],
  [/\bgusts up to\b/gi, 'rafales jusqu’à'],
  [/\bclose to your\b/gi, 'proches de votre'],
  [/\bover your\b/gi, 'au-dessus de votre'],
  [/\bwhile the low crosses\b/gi, 'pendant que la dépression traverse'],
  [/\bfresh winds while you are on this stretch\b/gi, 'vents frais pendant ce tronçon'],
  [/\bstrong winds while you are on this stretch\b/gi, 'vents forts pendant ce tronçon'],
  [/\blight winds while you are on this stretch\b/gi, 'vents faibles pendant ce tronçon'],
  [/\ball (\d+) forecast scenarios exceed your\b/gi, 'les $1 scénarios de prévision dépassent votre'],
  [/\b(\d+) of (\d+) forecast scenarios exceed your\b/gi, '$1 scénarios sur $2 dépassent votre'],
  [/The main signal:/gi, 'Signal principal :'],
  [/\bAn official marine warning covers part of your route\b/g, 'Une alerte marine officielle couvre une partie de votre route'],
  [/\bThat takes precedence over everything below\b/g, 'Elle prévaut sur tout ce qui suit'],
  [/\bForecasts update several times a day\b/g, 'Les prévisions sont mises à jour plusieurs fois par jour'],
  [/\bCheck again after the next model run\b/g, 'Vérifiez à nouveau après le prochain cycle du modèle'],
  [/\bexpected around\b/g, 'attendu vers'],
  [/\bespecially if you are close to your limits\b/g, 'surtout si les conditions sont proches de vos limites'],
  [/\bSome values in this briefing come from EMULATED \(synthetic\) data sources, marked with a badge\b/g, 'Certaines valeurs de ce briefing proviennent de sources de données SIMULÉES (synthétiques), signalées par un badge'],
  [/\bDo not use them for a real passage decision\b/g, 'Ne les utilisez pas pour prendre une décision de traversée réelle'],
  [/\bThis briefing does NOT cover\b/g, 'Ce briefing ne couvre PAS'],
  [/\bPartly assessed\b/g, 'Partiellement évalué'],
  [/\bNo warning here does not mean no risk\b/g, 'L’absence d’alerte ici ne signifie pas l’absence de risque'],
  [/\bNot assessed:/g, 'Non évalué :'],
  [/\bNo flag does not mean no risk\b/g, 'L’absence de signalement ne signifie pas l’absence de risque'],
  [/\btidal currents \(no prepared current grid\)/g, 'courants de marée (aucune grille de courants préparée)'],
  [/\btidal gates & HW\/LW heights \(no tide data\)/g, 'portes de marée et hauteurs PM/BM (aucune donnée de marée)'],
  [/\btropical systems\b/gi, 'systèmes tropicaux'],
  [/\bice\b/gi, 'glace'],
  [/\bpartially assessed\b/gi, 'partiellement évalué'],
  [/\bsustained wind\b/gi, 'vent moyen'],
  [/\bvisibility and convection\b/gi, 'visibilité et convection'],
  [/\bmodel agreement\b/gi, 'concordance des modèles'],
  [/\btidal currents\b/gi, 'courants de marée'],
  [/\btidal gates\b/gi, 'portes de marée'],
  [/\bofficial warnings\b/gi, 'alertes officielles'],
  [/\bsynoptic attribution\b/gi, 'attribution synoptique'],
  [/\bwind near\b/gi, 'vent près de'],
  [/\bwind\b/gi, 'vent'],
  [/\baround\b/gi, 'vers'],
  [/\bOff ([A-ZÀ-ÖØ-Ý][^→,.]*)/g, 'au large de $1'],
  [/\bNW of\b/g, 'NO de'],
  [/\bNE of\b/g, 'NE de'],
  [/\bSW of\b/g, 'SO de'],
  [/\bSE of\b/g, 'SE de'],
  [/\bE of\b/g, 'E de'],
  [/\bW of\b/g, 'O de'],
  [/\bPlymouth approach\b/gi, 'approche de Plymouth'],
  [/\bPlymouth breakwater\b/gi, 'brise-lames de Plymouth'],
  [/\bCasquets TSS crossing\b/gi, 'traversée du DST des Casquets'],
  [/\bMid-Channel\b/gi, 'milieu de la Manche'],
  [/\bwestern entrance\b/gi, 'entrée ouest'],
  [/\bwest of the Gulf of Lion\b/gi, 'à l’ouest du golfe du Lion'],
  [/\bthe Gulf of Lion\b/gi, 'le golfe du Lion'],
  [/\bthe eastern Channel\b/gi, 'l’est de la Manche'],
  [/\bforecast updates\b/gi, 'mise à jour des prévisions'],
  [/\bcheck again before you cast off\b/gi, 'vérifiez à nouveau avant d’appareiller'],
  [/\bThe forecast updates\b/g, 'La prévision est mise à jour'],
  [/\bThe forecast reaches\b/g, 'La prévision atteint'],
  [/\bagainst your\b/g, 'pour une limite de'],
  [/\blimit near\b/g, 'près de'],
  [/\bwhat sets this up\b/gi, 'ce qui met en place cette situation'],
  [/\bWind opposes the current\b/g, 'Le vent s’oppose au courant'],
  [/\bincreasing the risk of short, steep seas\b/g, 'ce qui augmente le risque de mer courte et abrupte'],
  [/\bStrongest near\b/g, 'Conditions les plus fortes près de'],
  [/\bnear waypoint\b/g, 'près du point de route'],
  [/\bwaypoint\s+(\d+)\b/gi, 'point de route $1'],
  [/\bwp(\d+)\b/gi, 'point de route $1'],
  [/\bgusts\b/gi, 'rafales'],
  [/\bwaves\b/gi, 'vagues'],
  [/\bWind over tide\b/g, 'Vent contre courant'],
  [/\bexpect short, steep seas\b/g, 'attendez-vous à une mer courte et abrupte'],
  [/\bWhy this assessment\b/g, 'Pourquoi cette évaluation'],
  [/\bmodels split\b/gi, 'divergence des modèles'],
  [/\bclose to your limits\b/gi, 'proche de vos limites'],
  [/\bbeyond your limits\b/gi, 'au-delà de vos limites'],
  [/\bfine\b/gi, 'dans les limites'],
  [/\bmodels diverge on\b/gi, 'les modèles divergent pendant'],
  [/\bof this passage\b/gi, 'sur cette traversée'],
  [/\bmodels in agreement across this passage\b/gi, 'modèles concordants sur toute la traversée'],
  [/\brun (\d{4}-\d{2}-\d{2}T[^ ]+) · age\b/g, 'cycle $1 · âge'],
  [/\bsystem undefined\b/gi, 'aucun système attribué'],
  [/\bsystem\b/gi, 'système'],
  [/\bboat\b/gi, 'bateau'],
  [/\bcause · Wind against current\b/gi, 'cause · Vent contre courant'],
  [/\blimits\b/gi, 'limites'],
  [/\blimit\b/gi, 'limite'],
  [/\bkt\b/g, 'nd'],
  [/(\d)kt\b/g, '$1 nd'],
  [/(\d+) NM\b/g, '$1 M'],
  [/\bStart\b/g, 'Départ'],
  [/\bFinish\b/g, 'Arrivée'],
  [/proches de votre limites/gi, 'proches de vos limites'],
  [/proche de votre limites/gi, 'proche de vos limites'],
  [/proches de votre (\d+(?:\.\d+)?) nd limite/gi, 'proches de votre limite de $1 nd'],
  [/au-dessus de votre (\d+(?:\.\d+)?) nd limite/gi, 'au-dessus de votre limite de $1 nd'],
  [/votre limite de (\d+(?:\.\d+)?) nd vent/gi, 'votre limite de vent de $1 nd'],
  [/votre (\d+(?:\.\d+)?) nd vent limite/gi, 'votre limite de vent de $1 nd'],
  [/votre vent limite/gi, 'votre limite de vent'],
  [/\b(\d+) of (\d+)\b/g, '$1 sur $2'],
  [/\b(\d+)\/(\d+) over\b/g, '$1/$2 au-dessus'],
  [/votre (\d+(?:\.\d+)?) nd limite/gi, 'votre limite de $1 nd'],
  [/ limite on /gi, ' limite sur '],
  [/près de approche de Plymouth/gi, 'près de l’approche de Plymouth'],
  [/près de point de route/gi, 'près du point de route'],
  [/mise à jour des prévisions\s*~/gi, 'mise à jour des prévisions vers '],
  [/default-limites\.json/g, 'default-limits.json'],
];

const FR_DATE_PARTS = {
  Sun: 'dim.', Mon: 'lun.', Tue: 'mar.', Wed: 'mer.', Thu: 'jeu.', Fri: 'ven.', Sat: 'sam.',
  Jan: 'janv.', Feb: 'févr.', Mar: 'mars', Apr: 'avr.', May: 'mai', Jun: 'juin',
  Jul: 'juil.', Aug: 'août', Sep: 'sept.', Oct: 'oct.', Nov: 'nov.', Dec: 'déc.',
};

function localizeDateParts(text) {
  return text.replace(/\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, (part) => FR_DATE_PARTS[part]);
}

export function translateText(value, language) {
  if (language !== 'fr' || !value) return value;
  const leading = value.match(/^\s*/)?.[0] ?? '';
  const trailing = value.match(/\s*$/)?.[0] ?? '';
  const key = value.trim();
  if (!key) return value;
  let translated = FR[key] ?? ruleLabelTranslations[key];
  if (!translated) {
    for (const [pattern, replacement, complete = false] of FR_PATTERNS) {
      if (pattern.test(key)) {
        translated = key.replace(pattern, replacement);
        // Complete diagnostics preserve identifiers without fragment/date substitutions.
        if (complete) return `${leading}${translated}${trailing}`;
        break;
      }
    }
  }
  translated ??= key;
  for (const [pattern, replacement] of FR_FRAGMENTS) translated = translated.replace(pattern, replacement);
  translated = localizeDateParts(translated);
  return `${leading}${translated}${trailing}`;
}

const originalText = new WeakMap();
const originalAttrs = new WeakMap();
const ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'];

function localizeText(node, language) {
  if (node.parentElement?.closest('script, style, pre, code')) return;
  let original = originalText.get(node);
  if (original === undefined || (node.data !== original && node.data !== translateText(original, 'fr'))) {
    original = node.data;
    originalText.set(node, original);
  }
  const next = translateText(original, language);
  if (node.data !== next) node.data = next;
}

function localizeAttributes(element, language, attributes = ATTRIBUTES) {
  let originals = originalAttrs.get(element);
  if (!originals) {
    originals = new Map();
    originalAttrs.set(element, originals);
  }
  for (const attr of attributes) {
    if (!element.hasAttribute(attr)) continue;
    const current = element.getAttribute(attr);
    let original = originals.get(attr);
    if (original === undefined || (current !== original && current !== translateText(original, 'fr'))) {
      original = current;
      originals.set(attr, original);
    }
    const next = translateText(original, language);
    if (current !== next) element.setAttribute(attr, next);
  }
}

function localize(root, language) {
  if (root.nodeType === Node.TEXT_NODE) {
    localizeText(root, language);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) localizeText(node, language);
  if (root.nodeType === Node.ELEMENT_NODE) localizeAttributes(root, language);
  for (const element of root.querySelectorAll('*')) localizeAttributes(element, language);
}

export function LocalizedDocument({ language }) {
  const previousLanguage = useRef(null);
  useLayoutEffect(() => {
    const root = document.getElementById('root') ?? document.body;
    document.documentElement.lang = language;
    const restoreEnglish = previousLanguage.current === 'fr';
    previousLanguage.current = language;
    if (language !== 'fr') {
      // A language switch restores translated nodes once; English never observes.
      if (restoreEnglish) localize(root, language);
      return;
    }

    const options = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES };
    const observer = new MutationObserver((records) => {
      // MutationObserver already batches writes. Process synchronously so cleanup
      // cannot leave a queued callback that reattaches an obsolete observer.
      observer.disconnect();
      try {
        const subtrees = new Set();
        for (const record of records) {
          if (record.type === 'childList') {
            for (const node of record.addedNodes) subtrees.add(node);
          }
        }
        const roots = [...subtrees].filter((node) => {
          if (!root.contains(node)) return false;
          for (let parent = node.parentNode; parent; parent = parent.parentNode) {
            if (subtrees.has(parent)) return false;
          }
          return true;
        });
        for (const node of roots) localize(node, language);
        for (const record of records) {
          if (!root.contains(record.target) || roots.some((node) => node.contains(record.target))) continue;
          if (record.type === 'characterData') localizeText(record.target, language);
          if (record.type === 'attributes') localizeAttributes(record.target, language, [record.attributeName]);
        }
      } finally {
        observer.observe(root, options);
      }
    });
    localize(root, language);
    observer.observe(root, options);
    return () => observer.disconnect();
  }, [language]);

  return null;
}
