import { de } from 'vuetify/locale'

export default {
  $vuetify: { ...de },
  drives: 'Laufwerke',
  settings: 'Einstellungen',
  settings_subtitle: 'Design, Flash Parameter und Sprache',
  dismiss: 'Ignorieren',
  download: 'Herunterladen',
  not_now: 'Später',
  install: 'Installieren',
  speed: 'Geschwindigkeit',
  device: 'Gerät',
  devices: 'Geräte',
  add_device: 'Gerät hinzufügen',
  remove_device: 'Gerät entfernen',
  close: 'Schließen',
  no_device_name: 'Kein Gerätename',
  no_devices_in_list: 'Keine Geräte in der Liste',
  devices_list_subtitle: 'Gerät hinzufügen durch Auswahl seiner .flock-Datei',
  swarm: 'Flotte',
  no_swarm: 'Keine Flotte',
  no_swarm_owner: 'Kein Flotteneigentümer',
  drive: 'Laufwerk',
  no_drive: 'Kein Laufwerk',
  no_drives_available: 'Keine Laufwerke verfügbar',
  select_drive: 'Wähle Laufwerk aus',
  selected_drive_no_longer_available: 'Das ausgewählte Laufwerk ist nicht mehr verfügbar',
  flash_drives: 'Flash Laufwerke',
  refresh_drive_list: 'Liste der Laufwerke erneuern',
  include_drive_for_flashing: 'Laufwerk beim Flashen berücksichtigen',
  use_all_drives: 'Benutze alle Laufwerke',
  board: 'Hardware',
  choose_board: 'Wähle Hardware',
  choose_hardware: 'Hardware',
  choose_variant: 'FlockOS-Variante',
  choose_hardware_first: 'Wähle zuerst die Hardware',
  variants: {
    base: 'Standard',
    nvidia: 'NVIDIA-GPU',
    rt: 'Echtzeit-Kernel'
  },
  installation: {
    method: 'Art der Installation',
    direct: 'Image auf dieses Laufwerk schreiben (es wird das Boot-Laufwerk des Geräts)',
    installer: 'Installations-Stick (installiert auf die interne Festplatte des Geräts)'
  },
  catalog: {
    refused: 'Der FlockOS-Katalog wurde abgelehnt, daher werden keine FlockOS-Images angeboten',
    offline: 'Offline: FlockOS-Images laut Katalog vom {issuedAt}',
    kept: 'Der FlockOS-Katalog konnte nicht aktualisiert werden; die Images sind die vom {issuedAt}',
    retry: 'Erneut versuchen'
  },
  specify_wlan_or_lan: 'Wähle SSID oder lokales Netzwerk',
  cancel_writing: 'Schreiben abbrechen',
  skip_verification: 'Überprüfung überspringen',
  try_again: 'Nochmals versuchen',
  export_log_report: 'Log Report exportieren',
  wlan_password: 'WiFi-Passwort',
  test_device: 'Gerät testen',
  flash: 'Flash',
  flash_all: 'Alle Geräte flashen',
  flashing_failed: 'Flashing fehlgeschlagen',
  flashing_canceled: 'Flashing abgesagt',
  verification_canceled: 'Gebrauchsfertig (Daten nicht überprüft)',
  hardware: 'Hardware',
  choose_image: 'Wähle Image aus',
  unavailable: 'Nicht verfügbar',
  name_unknown: 'Name unbekannt',
  edit: 'Bearbeiten',
  here: 'Hier',
  details: 'Details',
  submit: 'Bestätigen',
  mount: 'Einhängen',
  unmount: 'Aushängen',
  step: 'Schritt',
  completed: 'Fortschritt',
  eta: 'ETA',
  authentication_required: 'Authentifizierung erforderlich',
  authentication_explanation:
    'Bitte geben Sie Ihr Administrator Passwort für diesen Computer im unteren Feld ein, um dem FlockFlasher zu erlauben die ausgewählten Laufwerke zu überschreiben und alle Partition zu löschen',
  admin_password: 'Administrator Passwort',
  sd_cards_and_drives: 'SD Karten und USB Laufwerke',
  use_sd_cards_only: 'Benutze ausschließlich SD Karten',
  ready_to_use: 'Fertig und einsatzbereit',
  dark_mode: 'Dark mode',
  specify_read_block_size: 'Leseblockgröße auswählen (bytes)',
  specify_write_block_size: 'Schreibblockgröße auswählen (bytes)',
  choose_language: 'Sprache auswählen',
  environment_variables: 'Umgebungsvariablen',
  environment_variables_not_set:
    'Die folgende Umgebungsvariable ist ungültig oder nicht definiert: | Die folgenden Umgebungsvariablen sind ungültig oder nicht definiert:',
  please_ensure_environment_variables:
    'Um den FlockFlasher zu benutzen, stellen Sie bitte sicher, dass diese Umgebungsvariable richtig definiert wurde. | Um den FlockFlasher verwenden zu können, stellen Sie bitte sicher, dass die Umgebungsvariablen richtig definiert wurden.',
  exit_reflasher: 'FlockFlasher beenden',
  update_reagent: 'IronFlock Device Agent aktualisieren',
  download_reagent: 'IronFlock Device Agent herunterladen',
  docker_is_not_running: 'Docker läuft nicht',
  what_is_reagent_explanation:
    'Der IronFlock Device Agent ist die Anwendung, die für die Verwaltung von IronFlock Anwendungen auf einem IronFlock Gerät verantwortlich ist.',
  in_order_to_test_agent_is_required:
    'Um das Gerät auf Ihrem lokalen Computer testen zu können, müssen Sie den IronFlock Device Agent herunterladen.',
  agent_update_available:
    'Ein Update für den IronFlock Device Agent ist verfügbar! Fahren Sie mit dem Herunterladen des Updates fort.',
  docker_is_required: '{required}, um Ihr IronFlock-Gerät zu testen',
  docker_is_required_strong: 'Docker ist erforderlich',
  make_sure_docker_is_running:
    'Wenn Sie Docker bereits installiert haben, stellen Sie sicher, dass der {daemon} im Hintergrund läuft.',
  docker_daemon: 'Docker Daemon',
  docker_please_follow_instructions:
    'Bitte folgen Sie den Anweisungen {anchor} um Docker zu installieren.',
  improve_flash_performance: 'Den Flashingprozess verbessern',
  recommendations_regarding_flashing:
    'Hier sind einige Empfehlungen und Richtlinien für Probleme mit niedriger Schreib-/Lesegeschwindigkeit und/oder fehlgeschlagenem Flashing-Prozess:',
  if_flashing_keeps_failing:
    'Wenn das Flashen weiterhin fehlschlägt, versuchen Sie, die Größe des Schreibblocks zu verringern.',
  avoid_usb_2: 'Vermeiden Sie die Verwendung eines USB 2.0-Hubs',
  using_old_hardware: 'Verwenden Sie alte Hardware?',
  check_speed_drive: 'Kontrollieren Sie die angegebene Geschwindigkeit Ihres Flash-Laufwerks',
  check_documentation: 'Lesen Sie die Dokumentation',
  update: {
    announce: 'FlockFlasher Update verfügbar',
    download: 'Lade FlockFlasher Update',
    install: 'Beenden und Update installieren ?'
  },
  agent: {
    currently_running: 'Derzeit läuft: {name}',
    downloading: 'Geräte-Agent wird heruntergeladen…',
    download_finished: 'Geräte-Agent bereit',
    download_failed: 'Geräte-Agent konnte nicht heruntergeladen werden'
  },
  errors: {
    invalid_sudo_password: 'Das eingegebene Passwort ist falsch',
    no_drive_selected: 'Wählen Sie ein Laufwerk zum Flashen Ihres Images',
    no_image_selected: 'Wählen Sie die Hardware und eine FlockOS-Variante',
    only_device_files:
      'Fügen Sie ein Gerät mit seiner .flock-Datei hinzu: FlockFlasher schreibt nur FlockOS-Images aus dem signierten Katalog'
  },
  flashing_state: {
    inactive: 'Inaktiv',
    flashing: 'Schreiben...',
    starting: 'Initialisieren...',
    downloading: 'Image herunterladen...',
    downloadwait: 'Warten auf Download...',
    decompressing: 'Image entpacken...',
    verifying: 'Validieren...',
    mount: 'Laufwerk einhängen...',
    unmount: 'Laufwerk aushängen...',
    configure: 'Konfigurieren...',
    finish: 'Fertigstellen'
  }
}
