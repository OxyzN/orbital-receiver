# Orbital Cast Receiver (renders HTML UI on Nest Hub)

This folder is a **custom Google Cast receiver** web app. When you cast from the Android app, the Nest Hub will load this receiver URL and render the HTML UI.

## 1) Host this receiver over HTTPS

You need an **HTTPS** URL reachable by the Nest Hub (same Wi‑Fi). Common options:
- GitHub Pages
- Any HTTPS static host (Netlify, Cloudflare Pages, etc.)

The main entry point is `Receiver/index.html`.

## 2) Register a Custom Receiver in Google Cast SDK Developer Console

- Create a new **Custom Receiver** application
- Set the Receiver URL to your hosted `index.html`
- Copy the generated **Application ID**

## 3) Put the Application ID into the Android app

Update:
- `C:\Users\rafae\source\repos\Orbital\Orbital\Platforms\Android\Cast\CastConfig.cs`

Then rebuild + run on Android.

## What “cast the HTML UI” means

Chromecast devices don’t mirror your phone’s WebView. They load a **receiver web app** on the device itself.
This receiver shows the Radio Orbital UI and plays the live stream via CAF.

