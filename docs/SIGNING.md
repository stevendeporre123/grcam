# De .exe laten vertrouwen (Defender / SmartScreen)

Een niet-ondertekende .exe die van het internet komt, geeft bijna altijd een melding ("Windows heeft uw pc beschermd" van
SmartScreen of een waarschuwing van Defender). Dat zegt niets over de inhoud, enkel dat de uitgever onbekend is.

## Opties, van snel naar duurzaam

1. **Via de updatefunctie in de app.** Een door de app zelf gedownloade .exe krijgt geen "afkomstig van internet"-markering
   (Mark of the Web) en geeft dus meestal geen SmartScreen-melding. De eerste installatie blijft wel een gewone download.
2. **Bestand deblokkeren.** Rechtermuisknop → Eigenschappen → *Deblokkeren*, of in PowerShell:
   `Unblock-File .\PTZ-Backup-x.y.z-portable.exe`.
3. **Valse melding van Defender melden** bij Microsoft (Security Intelligence → *Submit a file*, "incorrectly detected as malware").
   Helpt bij een detectie, niet bij de SmartScreen-reputatie.
4. **Intern laten vertrouwen door IT (Stad Gent).** Op beheerde pc's kan IT de .exe toelaten op publisher of hash
   (Defender/AppLocker/WDAC) of ondertekenen met een intern code-signing-certificaat dat via beleid vertrouwd is. Voor een
   tool die enkel op de Televic-pc draait, is dit meestal de eenvoudigste en goedkoopste route.
5. **Een publiek vertrouwd certificaat.**
   * **Azure Artifact Signing** (voorheen Trusted Signing): ondertekenen vanuit de GitHub Action, zonder zelf sleutels te
     beheren. Publiek vertrouwde certificaten zijn beschikbaar voor *organisaties* in onder meer de EU; *individuele
     ontwikkelaars* enkel in de VS en Canada. Een identiteitscontrole van de organisatie (juridische entiteit,
     domein-e-mail, bedrijfsnummer) duurt 1–20 werkdagen. Een "private trust"-certificaat heeft geen geografische beperking,
     maar wordt enkel vertrouwd op pc's waar de uitgever dat root-certificaat heeft verspreid.
   * **Een code-signing-certificaat van een CA** (OV of EV, kost ca. enkele honderden euro per jaar). De sleutel moet op een
     hardwaretoken of in een cloud-HSM staan; cloudondertekening werkt in CI.
   * Een nieuw certificaat heeft aanvankelijk weinig SmartScreen-reputatie; die groeit met het aantal downloads.

## In de GitHub Action

Ondertekenen kan als stap vóór het uploaden van de release (bv. met `azure/artifact-signing-action` of `signtool`), met
de gegevens als *repository secrets*. Er staat nu bewust nog geen ondertekeningsstap in `.github/workflows/release.yml`:
die heeft een certificaat of account nodig.
