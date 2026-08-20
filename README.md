# ✦ Traumtagebuch · Nachtwelten

Ein Traumtagebuch mit coolen Graphiken – als eine einzige, in sich geschlossene
HTML-Datei. Kein Build, kein Server, keine Abhängigkeiten. Einfach `index.html`
im Browser öffnen.

## Features

- 🌌 **Animierter Sternenhimmel** auf `<canvas>`: funkelnde Sterne, leuchtender
  Mond, Aurora-Schimmer und gelegentliche Sternschnuppen.
- 📝 **Träume festhalten** mit Titel, Datum, Beschreibung, Stimmung und Symbolen/Tags.
- 😌 **Stimmungswähler** mit sechs Gemütszuständen (friedlich, freudig, seltsam,
  aufregend, angstvoll, traurig) – jede mit eigener Farbe.
- ✦ **Klartraum-Markierung** (Lucid Dream) mit eigenem Kartendesign.
- 📊 **Stimmungslandschaft**: animierte Balkengrafik der Häufigkeit deiner Stimmungen.
- 📈 **Statistiken**: Anzahl Träume, Klarträume, aktuelle Serie (Tage in Folge)
  und häufigste Stimmung.
- 🔍 **Suche & Tag-Filter** über alle Einträge.
- ✎ **Bearbeiten & Löschen** einzelner Träume.
- 💾 **Speicherung im Browser** (`localStorage`) – deine Daten verlassen den Rechner nicht.
- ↑↓ **Export / Import** als JSON zum Sichern oder Übertragen.

## Nutzung

```
index.html im Browser öffnen
```

Beim ersten Öffnen werden zwei Beispielträume angelegt, damit man sofort sieht,
wie es aussieht. Danach ist alles bearbeit- und löschbar.

## Technik

Reines HTML/CSS/JavaScript in einer Datei. Die Graphiken entstehen mit CSS-Gradienten,
Animationen und einer Canvas-Renderschleife (`requestAnimationFrame`).
