# Laskentakaavat ja -järjestys per pelaaja per vuoro

Kaikki `game_engine.json`:n `impacts`-skedulet sovelletaan ensin (kierroksen mukainen
"1"/"2"/"default"-avain päätöksen tekovuodesta laskettuna). Sen jälkeen alla olevat
johdetut kaavat lasketaan tässä järjestyksessä.

## Koko vuoron laskentajärjestys (lue tämä ensin)

Osiot 1-16 kuvaavat yksittäisiä kaavoja, mutta eivät sano missä järjestyksessä
ne suoritetaan yhden vuoron aikana, tai mitkä vaiheet vaativat KAIKKIEN
pelaajien tiedot ennen jatkamista. Tässä ehdotettu järjestys:

```
VAIHE A — Päätösten soveltaminen (per pelaaja, itsenäinen):
  A1. Sovella kaikkien aktiivisten päätösinstanssien impacts-skedulet
      (osio 9: additiivinen pinoutuminen kypsymisen mukaan; osio 0:
      target.*-kentät reititetään valitulle kohdepelaajalle)
  A2. Päivitä poistoledger (osio 1): laske voimassa olevat poistoerät,
      vähennä assets/intangibleAssets, kasvata depreciation_i

VAIHE B — Markkina (SYNKRONOINTIPISTE: vaatii KAIKKIEN pelaajien
          vaiheen A tulokset ennen kuin KENELLEKÄÄN voi laskea B:tä):
  B1. Jokaisen pelaajan competitiveness_i (osio 2)
  B2. marketShare_i = competitiveness_i / SUM(kaikkien pelaajien
      competitiveness_j) — vaatii koko pelaajajoukon summan
  B3. volume_i (osio 3, kapasiteettikatto)

VAIHE C — P&L (per pelaaja, itsenäinen, käyttää vaiheen B volume_i:tä):
  C1. revenue_i, COGS_i, EBITDA_i, EBIT_i, financeCost_i,
      profitBeforeTax_i, taxCost_i, netProfit_i (osio 4)

VAIHE D — Oikeusprosessi (PARIKOHTAINEN SYNKRONOINTI: jokainen case
          koskettaa kahta pelaajaa yhtä aikaa — haastetun maksu ON
          haastajan tulo saman transaktion sisällä. Tämä EI vaadi koko
          pelaajajoukon dataa kuten Vaihe B, mutta kummankin osapuolen
          Vaiheen A/D-tulokset on oltava valmiina ja päivitys on
          suoritettava ATOMISESTI molemmille ennen kuin KUMPIKAAN
          osapuoli siirtyy Vaiheeseen E — muuten toinen pelaaja voi
          nähdä siirron vain toiselta puolelta):
  D1. legalExposure_i JOKAISELLE pelaajalle, KAIKISTA avoimista caseista,
      AINA base probabilitylla (osio 7 — ei kehää, ks. osio 6 selitys)
  D2. legalExposureRatio_i siitä (osio 6-7)
  D3. adjustedProbability tälle vuorolle ratkeaville caseille (osio 6)
  D4. Arvo kunkin ratkeavan casen lopputulos, päivitä MOLEMMAT osapuolet
      (haastettu + haastaja) samassa transaktiossa

VAIHE E — Kassa ja tase (per pelaaja, käyttää vaiheiden C+D tuloksia):
  E1. cash_i, reserves_i, receivables_i, equity_i, marketEquity_i,
      stockValue_i (osio 5 — yksi yhtenäinen kaava)

VAIHE F — Putoamistarkistus (osio 12, 16):
  F1. cash_i < 0 TAI omistus >50% siirtynyt -> pelaaja putoaa
  F2. Jos putosi: waterfall-jako ratkaisemattomien casejen haastajille
      (osio 16)

VAIHE G — Global Risk Gauge (osio 7, käyttää vaiheen D tuloksia)
```

Vaihe B on ainoa synkronointipiste joka vaatii KAIKKI pelaajat kerralla
(markkinaosuus on nollasummapeli koko pelaajajoukon yli). Vaihe D vaatii
vain PARIKOHTAISEN atomisuuden (kahden osapuolen välillä per case), ei
koko pelaajajoukkoa. Muut vaiheet voi toteuttaa per-pelaaja-rinnakkain
näiden kahden rajoitteen puitteissa.

## 0. Kenttien kohdistus: oma tila vs. `target.*`

`game_engine.json`:ssa jokaisella pelaajalla on identtinen kenttäjoukko (kaikki
`impacts`-kentät, esim. cash, assets, outrage, processingLevel, jne. — ei enää
mitään erillisiä "competitor"-kenttiä). Kaksi tapaa kohdistaa vaikutus:

```
"cash": {...}              -> kohdistuu PÄÄTÖKSEN TEHNEESEEN pelaajaan itseensä
"target.cash": {...}       -> kohdistuu pelaajaan, joka valittiin toimen
                               KOHTEEKSI päätöstä tehtäessä (esim. kenen
                               tehtaaseen ketut päästetään, kenen osakkeita
                               ostetaan, kenen mainetta panetellaan)
```

Kaikki 9 kenttää, joilla on `target.`-versio: `target.cash`, `target.assets`,
`target.processLoss`, `target.supplySecurity`, `target.capacityUtilization`,
`target.processingLevel`, `target.scrutiny`, `target.outrage`,
`target.operatingExpenses`. Näitä käyttävät päätökset: Patent Trolling, Talent
Poaching, Raw Material Monopoly, Union Agitation, Bot Attack, Reporting Rivals,
Social Astroturf, Fox Release, Slander Chief Executive Officer, Patent
Portfolio, Buy Shares — kaikki ovat päätöksiä, joissa pelaaja valitsee toisen
pelaajan sabotaasin/hyökkäyksen kohteeksi.

`requiresTarget: true` -merkintä (Buy Shares, Sell Shares) tarkoittaa samaa
asiaa parametrisoiduille päätöksille — kohde valitaan pelihetkellä, ei
kiinteästi datassa.

## 1. Poistoledger (per hankinta)

Jokainen `assets`/`intangibleAssets`-kentän ABSOLUTE-tyyppinen POSITIIVINEN lisäys,
joka edustaa aitoa uutta hankintaa (ei arvon-oikaisua, ks. lista alla), luo poistoerän:

```
poistoera = { maara, ostovuosi, kayttoika }
kayttoika = assetUsefulLifeYears (10)     jos kohde on 'assets'
          = intangibleUsefulLifeYears (5)  jos kohde on 'intangibleAssets'

joka vuosi niin kauan kuin (nykyvuosi - ostovuosi) < kayttoika:
    depreciation_i += maara / kayttoika
    <assets tai intangibleAssets>_i -= maara / kayttoika
```

**Saa poistoeran** (aito hankinta): New Factory, Vertical Integration,
Off-Balance-Sheet SPV, Energy Efficiency Retrofit, Organic Shift (intangible),
Pelleting R&D (intangible), Patent Portfolio (intangible), Quality Certification
(intangible), Raw Material Monopoly (intangible, ent. stockValue-reititys).

**Ei saa poistoerää** (arvon-oikaisu, suora tasamuutos): Sale & Leaseback,
Maintenance Neglect, Preventive Maintenance, Laxatives in Feed.

**Ei koske alkuperäistä tasetta** (cash=100000, assets=1000000,
intangibleAssets=100000 pelin alussa) — se on olemassa oleva pohja, ei uusi hankinta.

## 2. Kilpailukyky ja markkinaosuus

```
effectiveDemand_i = (demand_i - outrageDemandWeight * outrage_i) / 100
competitiveness_i = (1/price_i) * (1 + wq*processingLevel_i + ws*supplySecurity_i
                                      - wl*processLoss_i + wd*effectiveDemand_i)
marketShare_i     = competitiveness_i / SUM_j(competitiveness_j)
```
Huom: `demand` ja `outrage` ovat pisteskaalalla (tyypillisesti -60..+60), siksi
jaetaan 100:lla ennen yhdistämistä 0-1-skaalaisiin processingLevel/supplySecurity/
processLoss-arvoihin.

## 3. Volyymi (tarjontakatto)

```
theoreticalVolume_i = marketShare_i * totalMarketVolume
maxSupply_i         = installedCapacity_i * capacityUtilization_i
volume_i            = MIN(theoreticalVolume_i, maxSupply_i)
```

**Kenttien rajat (VAHVISTETTU):** `processingLevel`, `capacityUtilization`,
`installedCapacity`, `price` — alaraja **0** kaikille (eivät voi mennä
negatiiviseksi additiivisen pinoutumisen — osio 9 — seurauksena), **ei
ylärajaa** millään näistä. Sovella `MAX(0, arvo)` jokaisen vuoron
laskennan jälkeen näille kentille.

## 4. Tulos (P&L)

```
revenue_i        = volume_i * price_i + (aktiiviset ABSOLUTE-tyyppiset revenue-skedulet)
COGS_i           = (materialCostPerTon_i + logisticsCostPerTon_i) * volume_i
grossProfit_i    = revenue_i - COGS_i
EBITDA_i         = grossProfit_i - operatingExpenses_i - staffCost_i + otherIncome_i
EBIT_i           = EBITDA_i - depreciation_i
financeCost_i    = baseFinanceCost + debt_i * interestRate
                   + (aktiiviset ABSOLUTE-tyyppiset financeCost-lisaykset, esim. Payday Loan)
profitBeforeTax_i = EBIT_i - financeCost_i
taxCost_i        = MAX(0, profitBeforeTax_i) * taxRate
                   + (aktiiviset ABSOLUTE-tyyppiset taxCost-oikaisut, esim. Tax Planning)
netProfit_i      = profitBeforeTax_i - taxCost_i
```

## 5. Tase ja kassavirtalaskelma

Kassa lasketaan **samalla tavalla kuin oikeassa kirjanpidossa**: yksi
kassavirtalaskelma (cash flow statement), joka jakautuu kolmeen
standardiluokkaan — operatiivinen, investoinnit, rahoitus. Tämä KORVAA
kaikki aiemmat, hajanaiset kassakaavat (mm. vanhan version osiosta 5 ja 16).

```
cash_i(nyt) = cash_i(edellinen)
            + operatiivinen_kassavirta_i
            + investointien_kassavirta_i
            + rahoituksen_kassavirta_i

operatiivinen_kassavirta_i  = netProfit_i + depreciation_i
                              (poisto ei ole kassavaikutteinen, lisätään takaisin)
                            + case-siirrot: saatu - maksettu (laskukaava alla)
                            + SUM(tämän vuoron aktiiviset päätösten cash-impaktit,
                                  joiden cashFlowCategory = "operating")

investointien_kassavirta_i  = SUM(tämän vuoron aktiiviset päätösten cash-impaktit,
                                   joiden cashFlowCategory = "investing")
                              (esim. New Factory, Vertical Integration,
                               Sale & Leaseback, Raw Material Monopoly —
                               kaikki assets/intangibleAssets-hankintaan tai
                               -luopumiseen liittyvät)

rahoituksen_kassavirta_i    = SUM(tämän vuoron aktiiviset päätösten cash-impaktit,
                                   joiden cashFlowCategory = "financing")
                              (esim. Bank Loan, Share Issuance, Excess Dividend,
                               Payday Loan, Buy Shares, Sell Shares — kaikki
                               debt/oman pääoman muutokseen liittyvät)
```

**Case-velvoitteen euromäärä** ("case-siirrot" yllä) lasketaan aina samalla
kaavalla (osio "Stakes"), riippumatta legalRiskin `impact.target`-kentästä:
```
absolute-tyyppi  -> schedule-arvo suoraan
relative-tyyppi  -> haastetun[target]-nykyarvo * schedule-arvo
```
Itse rahansiirto tapahtuu AINA `cash`-kentän kautta (haastetun cash vähenee,
haastajan cash kasvaa) — target-kenttää käytetään vain euromäärän
LASKEMISEEN (esim. suhteellisen %:n skaalauspohjana revenue/equitya vasten),
ei suoraan muokattavaksi kentäksi.

`cashFlowCategory` on nyt oma kenttä `game_engine.json`:ssa jokaisella
päätöksellä jolla on suora `cash`-impakti (24 päätöstä merkitty: 8
investing, 8 operating, 8 financing — ks. tiedosto). Koodarin ei tarvitse
päätellä luokkaa itse — se luetaan datasta.

**Pakollinen validointisääntö:** jokaisella päätöksellä jolla on suora
`cash`-impakti PITÄÄ olla myös `cashFlowCategory`-kenttä (operating/
investing/financing). Admin-paneelin päätöseditorin on estettävä
tallennus, jos `cash`-impakti lisätään ilman vastaavaa luokkaa — muuten
osion 5 kassavirtalaskelma ei osaa sijoittaa uutta päätöstä mihinkään
kolmesta summasta.

```
reserves_i    += netProfit_i
receivables_i  = revenue_i * (DSO / 365)
                 + (aktiiviset ABSOLUTE-tyyppiset receivables-lisaykset, esim. Channel Stuffing)
equity_i       = cash_i + receivables_i + assets_i + intangibleAssets_i + reserves_i - debt_i

marketEquity_i = MAX(0, equity_i - legalExposure_i)
stockValue_i   = marketEquity_i / totalSharesOutstanding_i
```
`equity_i` on kirjanpidollinen (tase-identiteetti, käytetään Full Company
Reportissa sellaisenaan). `stockValue_i` hinnoitellaan sen sijaan
`marketEquity_i`:stä — avoimet oikeusjutut alentavat suoraan osakekurssia,
mikä hinnoitellaan Buy Shares / Sell Shares -kaupoissa. Kahden luvun erotus
on syytä näyttää CEO:lle rinnakkain (ei vain lopputulos), jotta ero
kirjanpidon ja markkinan välillä ei näytä bugilta.

## 6. Oikeusprosessi

```
legalExposureRatio_i = MIN(legalExposureRatioCap, legalExposure_i / cash_i)
                        (legalExposureRatioCap = 0.8, admin-säädettävä)

adjustedProbability_case = baseProbability_legalRisk
                          * (1 + scrutinyLegalRiskMultiplier * scrutiny_haastettu / 100
                               + legalExposureRatio_haastettu)
```
Sovelletaan kun case ratkeaa oikeudessa (probability-arvon arvonta), ja myös
haastetulle näytettävään semaforiin/prosenttiin (koska haastettu "tietää omat
päätöksensä" — ks. aiempi keskustelu roolikohtaisesta näkyvyydestä).

Tämä tarkoittaa: mitä enemmän avoimia caseja sinua vastaan suhteessa kassaan,
sitä todennäköisemmin JOKAINEN niistä menestyy — lumipalloefekti, joka
palkitsee hyökkääjiä keskittämästä paineen yhteen haavoittuvaan pelaajaan.

**Laskentajärjestys ettei kehää synny:** koska `legalExposure_i` (osio 7)
käyttää AINA base probabilityä, se voidaan laskea itsenäisesti ilman
`legalExposureRatio`:a tai `adjustedProbability`:a. Järjestys per vuoro on
siis: (1) laske `legalExposure_i` kaikista avoimista caseista base-
todennäköisyyksillä, (2) johda `legalExposureRatio_i` siitä, (3) käytä
`legalExposureRatio_i`:tä `adjustedProbability`:n laskentaan niille caseille
jotka ratkeavat TÄLLÄ vuorolla. Ei tarvetta viivästää mitään seuraavaan
vuoroon — kehä ei koskaan pääse syntymään, koska (1) ei riipu (2):sta tai
(3):sta.

## 7. Global Risk Gauge

```
legalExposure_i      = SUM(avoimen casen BASE probability * tappio(EUR)) yli
                        kaikkien avoimien casejen joissa i on haastettu
                        (AINA base probability, EI adjustedProbability —
                        tämä katkaisee osion 6 kehämääritelmän: legalExposure
                        ei koskaan riipu itsestään)
legalExposureRatio_i = MIN(0.8, legalExposure_i / cash_i)      (sama kuin osio 6)

risk_i (0-100) = 100 * ( w1*(legalExposureRatio_i / 0.8)
                        + w2*(scrutiny_i / 100)
                        + w3*(outrage_i / 100) )
```
Painot (game_config.json): w1=0.5, w2=0.25, w3=0.25. Kaikki kolme termiä
jaettu omalla kattoarvollaan (0.8 / 100 / 100) ennen painotusta, joten kaikki
ovat vertailukelpoisesti 0-1-välillä — sama `legalExposureRatioCap`-jako
(0.8) käytetään sekä täällä että osiossa 6, eli normalisointi ratkeaa
YHDELLÄ määritelmällä molempiin tarkoituksiin.

## 8. processingLevel-kasvun hidastus (target.processingLevel)

Patent Portfolio -tyyppiset päätökset vähentävät suoraan kohteen processingLevel-arvoa
(yksinkertainen suora vähennys, ei kasvunopeuden dampausta - päätetty 2 kierrosta sitten).

## 9. Päätösten toistettavuus ja kypsyminen

```
kypsymisaika(paatos) = MAX(kaikki numeeriset schedule-avaimet paatoksen impacts-kentissa)
                       (pelkka "default" -> kypsymisaika 0, valittavissa heti uudelleen)

Paatos on UUDELLEEN VALITTAVISSA vasta kun edellinen instanssi on kypsynyt
(elapsed >= kypsymisaika).

Relative-tyyppiset vaikutukset USEAMMASTA aktiivisesta/kypsyneesta instanssista
SUMMAUTUVAT ADDITIIVISESTI (ei kerrottuna). Esim. kaksi kypsynytta New Factorya:
installedCapacity = base * (1 + 0.4 + 0.4), EI base * 1.4 * 1.4.
```

## 10. Excludes vapautuu kypsymisen myötä

```
Jos päätös A sulkee pois päätöksen B (excludes), B on lukittu niin kauan
kuin A:n tuorein instanssi ei ole kypsynyt. Kun A kypsyy, B vapautuu.
```

**Pakollinen validointisääntö admin-paneelin päätöseditorille:** `excludes` on
aina symmetrinen. Kun A:n excludes-listaan lisätään B, editorin on automaattisesti
varmistettava/lisättävä vastaava merkintä B:n excludes-listaan (ja päinvastoin
poistossa). Näin päätöksen A uudelleenvalinta ei voi koskaan lukita B:tä takaisin
kesken B:n oman kypsymisen, koska B:n valinta olisi jo estänyt A:n valinnan koko
B:n kypsymisen ajaksi.

## 11. Pelaajan putoaminen, itseosto ja case-määrät

**Sulautuminen/putoaminen:** kun pelaaja putoaa pelistä (>50% omistus siirtyy
ostajalle), kaikki hänen kesken olevat, vielä ratkaisemattomat casensa —
sekä ne joissa hän oli haastaja että haastettu — raukeavat normaalista
ratkaisustaan. Jako-osuus haastajille (`cash_i edellinen + tulot` -poolista,
haastamisjärjestyksessä) — ks. osio 16.

**Buy Shares voi kohdistua itseensä:** pelaaja voi ostaa takaisin omia,
aiemmin `EXTERNAL_MARKET`:lle laimentuneita osakkeitaan nostaakseen
omistusprosenttiaan takaisin ylös. Mekaniikka on sama kuin minkä tahansa
muun kohteen ostaminen (pro-rata kaikilta nykyisiltä omistajilta, mukaan
lukien `EXTERNAL_MARKET`), pelaaja vain valitsee kohteeksi oman yhtiönsä.

**Case-määrät:** pelaajaan **kohdistuvien** (hän on haastettuna) casejen
määrää ei ole rajoitettu — useampi eri pelaaja voi haastaa saman pelaajan
samanaikaisesti eri tai samoin perustein. Pelaaja **itse voi nostaa**
korkeintaan `maxLawsuitsPerPlayerPerTurn` (3) kannetta per vuoro — tämä raja
koskee vain lähteviä, ei saapuvia haasteita.

## 12. Voittoehto ja konkurssi

```
Peli jatkuu, kunnes vain YKSI pelaaja on jaljella. Ei kiintea vuosiraja,
ei pistepohjaista voittoa (cash/equity ei ratkaise, jos useampi pelaaja
on yha pelissa).

Pelaaja PUTOAA pelista kahdesta syysta:
  1. Sulautuminen: toinen pelaaja saavuttaa >50% omistuksen hanen
     yhtiostaan (ks. osio 11)
  2. Konkurssi: cash_i < 0 ENSIMMAISTA KERTAA millä tahansa vuorolla
     -> valitön häviö, pelaaja poistuu pelista

bankruptcyRisk-kentta on POISTETTU koko datasta (game_engine.json,
game_config.json) - se ei koskaan kytkeytynyt mihinkaan seuraukseen,
ja korvautuu nyt suoralla cash<0-ehdolla.
```

## 13. Mihin legalExposure vaikuttaa? (PÄÄTETTY)

`legalExposureRatio_i` (ks. osio 6, katto 0.8) vaikuttaa kolmeen asiaan:
1. Nostaa suoraan kaikkien sinua vastaan avoimien casejen menestymis-
   todennäköisyyttä (osio 6) — lumipalloefekti.
2. Syöttää Global Risk Gaugea (osio 7) samalla arvolla.
3. `legalExposure_i` (euromääräinen, ei suhdeluku) alentaa suoraan
   `marketEquity_i`:tä ja siten `stockValue_i`:tä (osio 5) — vireillä olevat
   oikeusjutut halventavat omaa osaketta, mikä helpottaa sinun ostamistasi/
   valtaamistasi juuri silloin kun olet haavoittuvaisimmillaan.

## 14. Samanaikaiset Buy Shares -ostot samaan kohteeseen

```
Jos kaksi pelaajaa ostaa saman kohteen osakkeita samalla vuorolla,
kasitellaan SAAPUMISJARJESTYKSESSA (FIFO, palvelimen vastaanottoaika).
Ensimmäinen osto suoritetaan ja päivittää cap tablen/hinnan ENNEN kuin
toista ostoa lasketaan.
```

## 15. Nollahintainen osake, käyttämättömät toiminnot ja vuoron samanaikaisuus

**Osake voi painua nollaan (VAHVISTETTU, ei minimikattoa):** `stockValue_i`
voi olla tasan 0, jos `legalExposure_i >= equity_i`. Tämä on tarkoituksella
sallittu — riittävän ahdistettu pelaaja voidaan ostaa/vallata ilmaiseksi
Buy Sharesilla. Ei minimihintaa.

**Käyttämättömät vuoron toiminnot (VAHVISTETTU): use it or lose it.**
Jos pelaaja ei käytä koko budjettiaan (1 strateginen + 2 operatiivista +
3 haastetta) 120s:n aikana, käyttämättömät eivät siirry seuraavalle
vuorolle — ne nollautuvat joka vuoro.

**Vuoron samanaikaisuus (VAHVISTETTU):** kaikki pelaajat toimivat SAMAN
120s-ikkunan sisällä yhtä aikaa (ei vuorotellen), ja kaikki vaikutukset
lasketaan yhdessä vuoron vaihtuessa.

## 16. Vuoron lopun käsittelyjärjestys (kaikki KPI-muutokset tapahtuvat tässä)

Kassan täydellinen kaava on nyt osiossa 5 (kolme kategoriaa: operatiivinen,
investoinnit, rahoitus) — tämä osio ei enää toista sitä, vain viittaa
siihen ja kuvaa PUTOAMISEN erityissäännöt.

Koko 120s-vuoro on pelaajien PÄÄTÖKSENTEKOA (valinnat, neuvottelut, haasteet)
— mikään KPI ei muutu ennen vuoron vaihtumista. Vuoron vaihtuessa lasketaan
`cash_i(nyt)` osion 5 kaavalla (yksi summa, ei erillistä vaiheistusta case-
velvoitteille vs. muulle P&L:lle — molemmat ovat vain rivejä samassa
summassa).

```
JOS cash_i (nyt) < 0 -> pelaaja PUTOAA PELISTÄ VÄLITTÖMÄSTI, sillä hetkellä.
```

Samoin sulautuminen (>50% omistus toiselle pelaajalle) pudottaa pelaajan
välittömästi sillä vuorolla kun kynnys ylittyy.

Kun pelaaja putoaa (kumpi tahansa syy), hänen VIELÄ RATKAISEMATTOMAT
casensa (sekä haastajana että haastettuna — ei siis tällä vuorolla jo
ratkenneet, jotka on jo laskettu `cash_i`-summaan) raukeavat eivätkä
etene omaan probability-arvontaansa.

```
jaettava_summa = cash_i (edellinen vuoro)
                + operatiivinen_kassavirta_i:n POSITIIVISET rivit
                + investointien_kassavirta_i:n POSITIIVISET rivit
                + rahoituksen_kassavirta_i:n POSITIIVISET rivit
                (eli kaikki TULOPUOLEN erät osiosta 5, EI vähennettynä
                menopuolen riveillä — esim. operatiiviset kulut, verot,
                capex-menot eivät pienennä tätä poolia)
```

Tästä poolista maksetaan haastajille (joiden case pudonnutta vastaan on
vielä ratkaisematta) HAASTAMISJÄRJESTYKSESSÄ (vanhin ensin), kukin täyteen
korvaukseensa asti kunnes pooli loppuu; viimeinen saaja, jonka kohdalla
raha loppuu kesken, saa jäljellä olevan osan; kaikki sen jälkeiset eivät
saa mitään. Oikeudelliset vaateet menevät menopuolen erien edelle, kun
yhtiö puretaan.

Sama sääntö koskee sekä konkurssia että sulautumista.

## Tunnetut avoimet kysymykset (ks. viimeisin chat-vastaus)

Katso erillinen avointen kysymysten lista - tämä dokumentti kuvaa vain jo PÄÄTETYT
kaavat.
