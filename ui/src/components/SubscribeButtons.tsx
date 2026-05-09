import { Broadcast, Check, Copy } from "@phosphor-icons/react";
import { useState } from "react";

import styles from "./SubscribeButtons.module.css";

interface Player {
  name: string;
  buildUrl: (feedUrl: string) => string;
}

const players: Player[] = [
  { name: "Apple Podcasts", buildUrl: (url) => url.replace(/^https?:\/\//, "podcast://") },
  { name: "Overcast", buildUrl: (url) => `overcast://x-callback-url/add?url=${encodeURIComponent(url)}` },
  { name: "Pocket Casts", buildUrl: (url) => `pktc://subscribe/${url}` },
  { name: "Castro", buildUrl: (url) => `castro://subscribe/${url}` },
  { name: "Spotify", buildUrl: (url) => `spotify:subscribe:${encodeURIComponent(url)}` }
];

export function SubscribeButtons({ feedUrl }: { feedUrl: string }) {
  const [copied, setCopied] = useState(false);

  async function copyFeed() {
    await navigator.clipboard.writeText(feedUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className={styles.subscribe}>
      <div className={styles.players}>
        {players.map((player) => (
          <a className={styles.player} href={player.buildUrl(feedUrl)} key={player.name}>
            <Broadcast size={14} weight="duotone" />
            <span>{player.name}</span>
          </a>
        ))}
      </div>
      <div className={styles.rss}>
        <code>{feedUrl}</code>
        <button onClick={copyFeed} type="button">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
