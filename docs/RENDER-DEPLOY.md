# Render'a canlıya alma (VDS yok, sunucu yönetimi yok)

Bu, uygulamayı internete açmanın önerilen yolu. Kodda hiçbir değişiklik
gerekmiyor - `render.yaml` dosyası (repo kökünde) Render'a ne yapması
gerektiğini zaten söylüyor.

## 1) Render hesabı aç ve repoyu bağla

1. https://render.com adresine git, GitHub hesabınla giriş yap.
2. Render, GitHub hesabına erişim isteyecek - `keyartisanetsy-ctrl/EtsyApp`
   reposuna izin ver (tüm repolara izin vermek zorunda değilsin, sadece bunu
   seçebilirsin).

## 2) Blueprint ile deploy et

1. Render panelinde **New +** → **Blueprint** seç.
2. `EtsyApp` reposunu seç.
3. Branch olarak `claude/etsy-bulk-management-app-q3enu5` seçili olduğundan
   emin ol (render.yaml zaten bunu varsayılan yapıyor).
4. Render, repodaki `render.yaml` dosyasını otomatik okuyacak ve
   `etsy-command-center` adında bir web servisi + 1 GB kalıcı disk
   önerecek. **Apply** / **Create** butonuna bas.
5. İlk build 5-10 dakika sürebilir (bağımlılıkları indirip arayüzü
   derliyor). Bittiğinde Render sana `https://etsy-command-center-xxxx.onrender.com`
   gibi bir adres verecek - uygulaman artık o adreste canlı.

Plan olarak **Starter** (aylık ~7 USD) kullanılıyor - **Free** planı 15
dakika boyunca istek gelmezse sunucuyu uyutuyor, bu da arka planda sürekli
çalışması gereken kargo takibi/sipariş senkronizasyonu gibi işleri durdurur.
Starter planında uygulama 7/24 açık kalır.

## 3) PUBLIC_HOST'u ayarla

1. Render panelinde servisine gir → **Environment** sekmesi.
2. `PUBLIC_HOST` değişkenini bul, değerine (http/https olmadan, sadece
   adres) Render'ın verdiği adresi yaz - örn. `etsy-command-center-xxxx.onrender.com`
   (kendi domainini bağladıysan onun yerine `keyartisan.us` yazacaksın,
   aşağıya bak).
3. Kaydet - Render otomatik olarak yeniden başlatır.

## 4) Kendi domainini bağlamak istersen (keyartisan.us)

1. Render'da servis → **Settings** → **Custom Domains** → **Add Custom Domain**.
2. `keyartisan.us` yaz. Render sana bir CNAME (ya da A/ALIAS) kaydı verecek.
3. Cloudflare DNS panelinde (`keyartisan.us` zone'unda) o kaydı ekle -
   Cloudflare'ın turuncu bulut/proxy özelliğini bu kayıt için **kapalı**
   (DNS only, gri bulut) tut ki Render'ın kendi SSL sertifikası çalışsın.
4. DNS yayıldıktan sonra (birkaç dakika-birkaç saat) `https://keyartisan.us`
   uygulamana gidecek.
5. `PUBLIC_HOST` ortam değişkenini `keyartisan.us` olarak güncelle (3. adım).

## 5) Etsy / Shopify bağlantılarını yeni adrese güncelle

Kod tarafında hiçbir şey değişmiyor - adresler tamamen Ayarlar sayfasından
yönetiliyor:

1. Uygulamayı aç → **Ayarlar**.
2. **OAuth redirect URI** alanına tam olarak şunu yaz:
   `https://<adresin>/api/auth/callback` (örn. `https://keyartisan.us/api/auth/callback`)
3. Etsy Geliştirici Panelinde (Etsy Developer Dashboard) uygulamanın
   **Redirect URIs** listesine aynı adresi ekle - karakteri karakterine
   aynı olmalı.
4. Shopify tarafı için de aynı mantık: Shopify Partner Dashboard'daki
   **App URL** / **Allowed redirection URL(s)** alanına
   `https://<adresin>/api/shopify/oauth/callback` yaz.

## Neden hiçbir kod değişikliği gerekmedi

- Veritabanı dosyası (`data/etsy-command-center.db`), yüklenen dosyalar ve
  Excel export'ları zaten `DATA_DIR` ortam değişkenine göre yazılıyor - onu
  Render'ın kalıcı diskine (`/var/data`) işaret ettirmek yeterli.
  `render.yaml` bunu otomatik yapıyor.
- Web arayüzü API'ye hep göreli yollarla (`/api/...`) istek atıyor, yani
  hangi domainde çalıştığı önemli değil.
- Arka plan zamanlayıcıları (`scheduler.js`) normal bir Node süreci olarak
  çalışmaya devam ediyor - Render'ın Starter planı süreci uyutmadığı için
  bunlar olduğu gibi çalışır.

## Railway kullanmak istersen

Render yerine Railway'i tercih edersen adımlar neredeyse aynı: yeni proje →
GitHub reposunu bağla → Railway otomatik olarak Node projesini algılar →
**Variables** sekmesinden yukarıdaki `NODE_ENV`, `HOST=0.0.0.0`,
`OPEN_BROWSER=0`, `PUBLIC_HOST` değişkenlerini ekle → **Volumes**
sekmesinden bir disk oluşturup `DATA_DIR` ile aynı yola bağla (örn.
`/data`). `render.yaml` dosyası Railway tarafından kullanılmaz, o yüzden bu
ayarları panelden elle girmen gerekir.
