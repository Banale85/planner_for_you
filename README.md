# Planner for You

Calendario in stile Microsoft Teams + quaderni per appunti in stile Noteful, con cartelle e sottocartelle.
È una **web app installabile (PWA)**: funziona su iPad, iPhone, Android, Windows e Mac **senza App Store**, anche offline.

## Cosa c'è dentro

**Calendario (stile Teams)**
- Viste Giorno, Settimana lavorativa, Settimana, Mese, **Anno**, Agenda
- Mini calendario laterale (si apre anche toccando la data in alto): tocca un giorno, il numero della settimana, il mese o l'anno per andarci subito; scorciatoie "Domani", "Prossima settimana", "Mese prossimo"
- Scorri con un dito a sinistra/destra per cambiare periodo; da tastiera T = oggi, ← → = avanti/indietro, 1–6 = viste
- "Nuova riunione" con partecipanti, luogo, link Teams e pulsante **Partecipa**
- Ricorrenze (giornaliera, feriale, settimanale con giorni a scelta, mensile, annuale, "fino al")
- Promemoria, categorie a colori, "Mostra come" (Occupato/Libero/Provvisorio/Fuori sede)
- Trascina gli eventi per spostarli (mouse e penna subito, col dito tieni premuto un attimo e poi trascina), anche nella vista Mese e per gli eventi ricorrenti, con "Annulla"; trascina il bordo in basso per allungarli; trascina sulla griglia per creare
- **Scrivi**: penna, evidenziatore, gomma, lazo e testo da tastiera direttamente sopra il calendario
- Note di ogni riunione a **tastiera** o a **penna**, e pulsante "Prendi appunti" che crea un quaderno collegato
- Importa/esporta `.ics` (calendario di Teams/Outlook)

**Sincronizzazione**
- Tutto su Google Drive (15 GB gratuiti), visibile su iPad, PC e telefono senza backup manuali

**Appunti (stile Noteful)**
- Cartelle e sottocartelle illimitate, colori, trascinamento, "Sposta in…", ricerca, Recenti
- Quaderni con copertina e carta bianca / a righe / quadretti / puntini / Cornell
- Penna sensibile alla pressione, evidenziatore, gomma, lazo (sposta, ridimensiona, duplica, ricolora), testo, immagini
- Importa PDF da annotare, esporta in PDF o immagine
- Pagine: aggiungi, duplica, riordina, elimina; zoom con due dita o Ctrl+rotellina
- "Solo penna": con Apple Pencil/S Pen il dito scorre la pagina (si attiva da solo)

## Provarla sul PC

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```
poi apri http://localhost:8080

## Usarla su tutti i dispositivi (senza App Store)

Serve pubblicare la cartella su un sito HTTPS gratuito, per esempio:
- **Netlify Drop**: vai su https://app.netlify.com/drop e trascina questa cartella.
- **GitHub Pages**: carica i file in un repository e attiva Pages.

Poi, dal dispositivo, apri l'indirizzo e:
- **iPad/iPhone**: Safari → Condividi → "Aggiungi alla schermata Home"
- **Android**: Chrome → ⋮ → "Installa app"
- **Windows/Mac**: Chrome/Edge → icona "Installa" nella barra degli indirizzi

Quando modifichi i file, aumenta `VERSION` in `sw.js` così i dispositivi scaricano l'aggiornamento.

## Sincronizzazione tra dispositivi con Google Drive

Tutto (cartelle, quaderni, scritte a penna, calendario, PDF) viene salvato nel tuo Google Drive,
nella cartella **"Planner for You"**, e compare sugli altri dispositivi in circa 20–30 secondi.
L'app funziona anche offline: le modifiche partono appena torna la connessione.

### Passo 1 – Pubblica l'app (serve un indirizzo https)
1. Vai su https://app.netlify.com/drop e trascina la cartella `planner_for_you`.
2. Annota l'indirizzo che ti dà Netlify, per esempio `https://planner-mario.netlify.app/`
   (puoi cambiarlo in "Site configuration → Change site name").

### Passo 2 – Crea il "Client ID" Google (gratis, una volta sola)
1. Apri https://console.cloud.google.com e accedi con il tuo account Google.
2. In alto: selettore progetti → **Nuovo progetto** → nome "Planner for You" → **Crea**, poi selezionalo.
3. Menu ☰ → **API e servizi → Libreria** → cerca **Google Drive API** → **Abilita**.
4. Menu ☰ → **Google Auth Platform** (o "Schermata consenso OAuth") → **Inizia**:
   - Nome app: `Planner for You`, email di assistenza: la tua
   - Pubblico: **Esterno**
   - Dati di contatto: la tua email → accetta le norme → **Crea**
5. **Pubblico** → *Utenti di test* → **Aggiungi utenti** → la tua Gmail → Salva.
6. **Client** → **Crea client** → Tipo: **Applicazione web**, poi aggiungi:
   - *Origini JavaScript autorizzate*: `https://planner-mario.netlify.app` e `http://localhost:8080`
   - *URI di reindirizzamento autorizzati*: `https://planner-mario.netlify.app/` e `http://localhost:8080/` (con la barra finale)
   - **Crea** e copia l'**ID client** (finisce con `.apps.googleusercontent.com`).
7. Facoltativo ma consigliato: in **Pubblico** premi **Pubblica app** (passa "In produzione").
   L'app usa solo il permesso "file creati da questa app", che non richiede verifiche da parte di Google,
   e così non ti chiederà di riconfermare l'accesso ogni settimana.

### Passo 3 – Inserisci il Client ID e collega i dispositivi
1. Apri `js/config.js` e incolla l'ID: `export const GOOGLE_CLIENT_ID = '...apps.googleusercontent.com';`
2. Trascina di nuovo la cartella su Netlify Drop *dello stesso sito* (Deploys → trascina la cartella) per aggiornarlo.
   (In alternativa puoi incollare l'ID in Impostazioni su ogni dispositivo, senza ripubblicare.)
3. Su **ogni dispositivo**: apri l'app → Impostazioni → **Collega Google Drive** → scegli il tuo account → Consenti.
   Il primo dispositivo carica tutto ciò che contiene già; gli altri lo ricevono.

### Come si comporta
- Nella barra laterale il pulsante **Sync** mostra lo stato (pallino verde = sincronizzato, arancione = "Riconnetti").
- Il permesso Google dura circa un'ora: all'apertura dell'app viene rinnovato da solo (vedrai un attimo la pagina di Google).
  Se lo usi per più di un'ora di fila, il pulsante diventa "Riconnetti": un tocco e riparte.
- I PDF vengono caricati su Drive una volta sola e scaricati sugli altri dispositivi solo quando apri quel quaderno.
- Se scrivi sulla stessa pagina da due dispositivi senza connessione, i tratti vengono **uniti**, non sovrascritti.
- L'app può vedere solo i file che ha creato lei: il resto del tuo Drive resta inaccessibile.

## Da sapere
- Senza Google Drive collegato, i dati restano solo sul dispositivo (IndexedDB). Il backup manuale resta disponibile in Impostazioni.
- Il calendario Teams si importa via file `.ics`; la sincronizzazione automatica in tempo reale richiederebbe una registrazione dell'app su Microsoft (Azure) e spesso il consenso dell'università.
- Le notifiche arrivano mentre l'app è aperta (su iPhone/iPad solo dopo averla installata).
- **iPad con Apple Pencil**: dopo aver usato la penna, iPad potrebbe non aprire la tastiera nei campi di testo
  (si aspetta la scrittura a mano, funzione *Scribble*). Per evitarlo: Impostazioni di iPad → Apple Pencil → disattiva **Scribble**.
  In alternativa, tocca il campo con il dito invece che con la penna.
