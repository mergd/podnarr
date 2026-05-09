import {
  ArrowLeft,
  ArrowSquareOut,
  CircleNotch,
  FileText
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";

import type {
  HomeResponse,
  PostDetailResponse,
  PublicationDetailResponse,
  PostSummary
} from "@podnarr/shared/api";

import { InlineAudioPlayer } from "./components/InlineAudioPlayer";
import { PodnarrLogo } from "./components/PodnarrLogo";
import { SubscribeButtons } from "./components/SubscribeButtons";
import { fetchHome, fetchPost, fetchShow } from "./lib/api";
import { formatDate, formatDuration } from "./lib/date";
import styles from "./App.module.css";

type ViewState =
  | { kind: "loading" }
  | { kind: "home"; data: HomeResponse }
  | { kind: "show"; data: PublicationDetailResponse }
  | { kind: "episode"; data: PostDetailResponse }
  | { kind: "error"; message: string };

function getSlugFromPath(): string | null {
  const match = /^\/shows\/([^/]+)$/.exec(window.location.pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function getEpisodeIdFromPath(): number | null {
  const match = /^\/shows\/[^/]+\/episodes\/(\d+)$/.exec(window.location.pathname);
  return match?.[1] ? Number(match[1]) : null;
}

function navigate(path: string) {
  const go = () => {
    window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => unknown;
  };
  if (typeof doc.startViewTransition === "function") {
    doc.startViewTransition(go);
  } else {
    go();
  }
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={styles.badge} data-status={status.toLowerCase()}>
      {status}
    </span>
  );
}

function EpisodeRow({ post }: { post: PostSummary }) {
  return (
    <article className={styles.episode}>
      <div className={styles.episodeMain}>
        <div className={styles.episodeMeta}>
          <StatusBadge status={post.status} />
          <span>{formatDate(post.pubDate)}</span>
          <span>{formatDuration(post.durationSeconds)}</span>
          {post.estimatedCostUsd !== null ? <span>est. ${post.estimatedCostUsd.toFixed(2)}</span> : null}
        </div>
        <button
          className={styles.episodeTitle}
          onClick={() => navigate(`/shows/${post.publicationSlug}/episodes/${post.id}`)}
          type="button"
        >
          {post.title}
        </button>
        {post.audioUrl ? (
          <InlineAudioPlayer
            className={styles.inlinePlayer}
            label={`Play ${post.title}`}
            src={post.audioUrl}
          />
        ) : null}
        <div className={styles.episodeActions}>
          <button
            onClick={() => navigate(`/shows/${post.publicationSlug}/episodes/${post.id}`)}
            type="button"
          >
            <FileText size={13} weight="duotone" />
            Transcript
          </button>
          {post.canonicalUrl ? (
            <a href={post.canonicalUrl} rel="noreferrer" target="_blank">
              <ArrowSquareOut size={13} weight="duotone" />
              Source
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <button className={styles.brand} onClick={() => navigate("/")} type="button">
            <span className={styles.brandMark}>
              <PodnarrLogo size={14} />
            </span>
            <span className={styles.brandName}>podnarr</span>
          </button>
          <span className={styles.headerNote}>Narrated newsletter feeds</span>
        </div>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}

function Cover({ src, alt = "" }: { src: string | null; alt?: string }) {
  return (
    <div className={styles.coverWrap}>
      <img alt={alt} className={styles.cover} src={src ?? "/icon.svg"} />
      <span className={styles.coverCorner} aria-hidden="true">
        <PodnarrLogo size={10} />
      </span>
    </div>
  );
}

function Home({ data }: { data: HomeResponse }) {
  return (
    <Shell>
      <section className={styles.hero}>
        <p className={styles.kicker}>Narrated newsletters</p>
        <h1>Podcast feeds for long-form Substack essays.</h1>
        <p className={styles.lede}>
          Public feeds for generated narration. Newsletter ingestion stays private.
        </p>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2>
            Shows <small>{data.publications.length}</small>
          </h2>
        </div>
        <div className={styles.showGrid}>
          {data.publications.map((publication) => (
            <button
              className={styles.showCard}
              key={publication.slug}
              onClick={() => navigate(`/shows/${publication.slug}`)}
              type="button"
            >
              <span className={styles.showArt}>
                <img alt="" src={publication.imageUrl ?? "/icon.svg"} />
              </span>
              <span className={styles.showCardText}>
                <strong>{publication.title}</strong>
                <small>{publication.author ?? publication.status}</small>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2>Latest episodes</h2>
        </div>
        <div className={styles.episodeList}>
          {data.latestPosts.map((post) => (
            <EpisodeRow key={post.id} post={post} />
          ))}
        </div>
      </section>
    </Shell>
  );
}

function Show({ data }: { data: PublicationDetailResponse }) {
  const readyCount = useMemo(
    () => data.posts.filter((post) => post.status === "ready").length,
    [data.posts]
  );

  return (
    <Shell>
      <button className={styles.back} onClick={() => navigate("/")} type="button">
        <ArrowLeft size={14} weight="bold" />
        Shows
      </button>
      <section className={styles.showHero}>
        <Cover src={data.publication.imageUrl} />
        <div className={styles.heroContent}>
          <div className={styles.eyebrowRow}>
            <p className={styles.kicker}>Narrated feed</p>
            <span className={styles.heroMeta}>
              {readyCount} ready · {data.posts.length} tracked
            </span>
          </div>
          <h1>{data.publication.title}</h1>
          {data.publication.description ? (
            <p className={styles.lede}>{data.publication.description}</p>
          ) : null}
          <div className={styles.stats}>
            <StatusBadge status={data.publication.status} />
            {data.publication.lastRefreshedAt ? (
              <span>Updated {formatDate(data.publication.lastRefreshedAt)}</span>
            ) : null}
          </div>
          <SubscribeButtons feedUrl={data.publication.rssUrl} />
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2>
            Episodes <small>{data.posts.length}</small>
          </h2>
        </div>
        <div className={styles.episodeList}>
          {data.posts.map((post) => (
            <EpisodeRow key={post.id} post={post} />
          ))}
        </div>
      </section>
    </Shell>
  );
}

function Episode({ data }: { data: PostDetailResponse }) {
  const { post } = data;

  return (
    <Shell>
      <button
        className={styles.back}
        onClick={() => navigate(`/shows/${post.publicationSlug}`)}
        type="button"
      >
        <ArrowLeft size={14} weight="bold" />
        Episodes
      </button>
      <article className={styles.episodePage}>
        <header className={styles.episodeHeader}>
          <p className={styles.kicker}>Episode</p>
          <h1>{post.title}</h1>
          <div className={styles.stats}>
            <StatusBadge status={post.status} />
            <span>{formatDate(post.pubDate)}</span>
            <span>{formatDuration(post.durationSeconds)}</span>
            {post.ttsVoice ? <span>{post.ttsVoice}</span> : null}
          </div>
          {post.canonicalUrl ? (
            <div className={styles.episodeActions}>
              <a href={post.canonicalUrl} rel="noreferrer" target="_blank">
                <ArrowSquareOut size={13} weight="duotone" />
                Source article
              </a>
            </div>
          ) : null}
        </header>
        {post.audioUrl ? (
          <InlineAudioPlayer label={`Play ${post.title}`} src={post.audioUrl} />
        ) : null}
        {post.lastError ? <div className={styles.error}>{post.lastError}</div> : null}
        {post.visualMetadata.length > 0 ? (
          <section className={styles.transcriptBlock}>
            <h2>Visuals</h2>
            <ol className={styles.visualList}>
              {post.visualMetadata.map((visual, index) => (
                <li key={`${visual.src ?? visual.caption ?? visual.alt ?? "visual"}-${index}`}>
                  <span>{visual.alt || visual.caption || "Image appears in article"}</span>
                  {visual.src ? (
                    <a href={visual.src} rel="noreferrer" target="_blank">
                      Open
                    </a>
                  ) : null}
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        <section className={styles.transcriptBlock}>
          <h2>Transcript source</h2>
          <pre>{post.script || post.textContent || "No transcript source available."}</pre>
        </section>
      </article>
    </Shell>
  );
}

export function App() {
  const [state, setState] = useState<ViewState>({ kind: "loading" });

  useEffect(() => {
    async function load() {
      setState({ kind: "loading" });
      try {
        const slug = getSlugFromPath();
        const episodeId = getEpisodeIdFromPath();
        if (episodeId) {
          setState({ kind: "episode", data: await fetchPost(episodeId) });
        } else if (slug) {
          setState({ kind: "show", data: await fetchShow(slug) });
        } else {
          setState({ kind: "home", data: await fetchHome() });
        }
      } catch (error) {
        setState({ kind: "error", message: error instanceof Error ? error.message : "Request failed" });
      }
    }

    void load();
    window.addEventListener("popstate", load);
    return () => window.removeEventListener("popstate", load);
  }, []);

  if (state.kind === "loading") {
    return (
      <Shell>
        <div className={styles.loading}>
          <CircleNotch className={styles.spin} size={14} weight="bold" />
          Loading
        </div>
      </Shell>
    );
  }

  if (state.kind === "error") {
    return (
      <Shell>
        <div className={styles.error}>{state.message}</div>
      </Shell>
    );
  }

  if (state.kind === "episode") {
    return <Episode data={state.data} />;
  }

  return state.kind === "show" ? <Show data={state.data} /> : <Home data={state.data} />;
}
