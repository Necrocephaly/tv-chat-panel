# TV Chat Panel (unofficial)

A small chat panel for TradingView's old **public chat rooms**, as a
[Tampermonkey](https://www.tampermonkey.net/) userscript.

TradingView retired the public chat page on 30 September 2026. This panel
brings back a simple version of that chat window inside any tradingview.com tab,
for as long as TradingView's chat servers keep answering.

> **Unofficial.** This project is not affiliated with, endorsed by or supported
> by TradingView. "TradingView" is a trademark of its owner. It may stop
> working at any time, and TradingView may ask people not to use it. Use it at
> your own risk.

## Version 1.2 changes

- The **quote** button is in each message's hover controls, directly left of
  the **⋮** menu. Subscription badges now sit beside the username.

## Version 1.1 changes

- **Select chat text:** drag across messages to highlight and copy the part you
  want. Selecting a username does not insert an @mention; a normal click still
  does.
- **Short, wide panel:** open **⚙ Appearance → Panel size → Two messages** for
  a panel about 440 × 180 pixels. **Regular** restores the original 340 × 460
  size. You can still resize from the corner, and your chosen size is saved.
  Longer messages, quotes and snapshots may take up more than one message's
  worth of space.
- **Username glow:** turn it on in **⚙ Appearance** and set **Glow intensity**
  from 1 to 5. It is off by default; the setting is saved in your browser.

## What it does

- Lists the public rooms and shows the conversation, newest at the bottom.
- Send messages with **Enter**; **Shift+Enter** starts a new line.
- **Quotes:** hover a message and click **❝** beside its **⋮** menu. Quotes
  show as boxes.
- **Emoji:** the smiley button inserts the old chat's `:codes:` (`:bull:`,
  `:rocket:`…), and `:)` style smileys show as faces.
- **@mentions:** click a name to mention them. Mentions of you are
  highlighted, and **@me** shows only those.
- **Chart sharing:** the camera button takes a TradingView snapshot of the
  chart you're on and puts the link in your message. Snapshots show as
  pictures; click one to see it large.
- **Chart tags:** each message shows the symbol and timeframe its sender was
  viewing; click to open it.
- **⋮ menu** on each message: copy the text, or delete your own message.
- **Jump to present** when you've scrolled back.
- Select and copy text directly from the chat history.
- **Appearance (⚙):** text size, font, colours, panel size and username glow.
- Drag the title bar to move it, drag the corner to resize it. It remembers
  its place, size and room.

## How it works

It uses **your own** logged-in TradingView session in **your own** browser tab,
and makes the same requests the old chat page made. It doesn't collect, store
or send your data anywhere else, and it has no server of its own. Settings are
saved only in your browser.

## Install

1. Install the **Tampermonkey** extension for Chrome, Edge or Firefox.
2. In Chrome or Edge, open `chrome://extensions`, click **Details** on
   Tampermonkey, and turn on **Allow User Scripts**.
3. Click the Tampermonkey icon, then **Create a new script…**, and delete the
   template text.
4. Paste in the whole of [tv-chat-panel.user.js](tv-chat-panel.user.js), then
   press **Ctrl+S**.
5. Open or refresh https://www.tradingview.com while signed in. The panel
   appears in the corner.

### Update an existing copy

1. Open **Tampermonkey → Dashboard** and open your existing TV Chat Panel script.
2. Replace its entire contents with the current
   [tv-chat-panel.user.js](tv-chat-panel.user.js) (version 1.2), then press
   **Ctrl+S**. Update the existing script rather than creating a second copy.
3. Refresh the TradingView tab. Pushing a change to GitHub does not update a
   script that you previously pasted into Tampermonkey.

The older `tv-chat-revival` desktop folder contains an earlier script; use the
file linked above for the current version.

It works in a browser tab, not in the TradingView desktop app.

## Licence

Copyright (c) 2026. **All rights reserved.** You're welcome to install and use
the script. No licence is granted to copy, modify or redistribute it.
