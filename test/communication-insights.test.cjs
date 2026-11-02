const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Types } = require("mongoose");
const { getConnectionToken } = require("@nestjs/mongoose");
const database = "np_communication_" + randomUUID().replaceAll("-", "");
// Cenários isolados, sem acessar usuários, publicações ou histórico reais.
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/" + database;
process.env.NODE_ENV = "test";
process.env.CLIENT_ORIGIN = "http://localhost:5174";
process.env.ALLOW_REGISTRATION = "true";
process.env.EMAIL_VERIFICATION_REQUIRED = "false";
const { createApp } = require("../dist/bootstrap");
const { consumptionHistory, annualInsights } = require("../dist/social/insights.module");
test("datas desconhecidas não viram consumo no ano de cadastro; sessões e revisitas preservam suas datas", () => {
  const items = [
    {
      _id: "a",
      title: "Filme",
      kind: "movie",
      status: "completed",
      runtime: 90,
      stars: 5,
      genres: ["Drama"],
      completedOn: "2020-03-01",
      rewatches: [{ id: "r", completedAt: new Date("2021-02-02"), completedOn: "2021-02-02" }],
    },
    {
      _id: "b",
      title: "Antigo",
      kind: "book",
      status: "completed",
      watchedDateUnknown: true,
      completedAt: new Date("2026-01-01"),
      stars: 4,
    },
    {
      _id: "g",
      title: "Jogo",
      kind: "game",
      status: "active",
      playtimeMinutes: 1000,
      gameSessions: [{ id: "s", playedOn: "2022-01-01", minutes: 50 }],
    },
    { _id: "tv", catalogId: "series", title: "Série", kind: "series", status: "active" },
  ];
  const events = consumptionHistory(
    items,
    [{ _id: "e", itemId: "tv", season: 1, episode: 1, watchedAt: new Date("2020-01-01") }],
    [{ catalogId: "series", number: 1, episodes: [{ number: 1, runtime: 40 }] }],
  );
  const summary = annualInsights(items, events);
  assert.equal(summary.unknownDates, 2);
  assert.equal(
    summary.years.some((row) => row.year === "2026"),
    false,
  );
  assert.equal(summary.years.find((row) => row.year === "2020").minutes, 130);
  assert.equal(summary.years.find((row) => row.year === "2021").rewatches, 1);
  assert.equal(summary.years.find((row) => row.year === "2022").gameMinutes, 50);
  assert.equal(summary.allTimeFavorites.length, 2);
  const zoned = consumptionHistory(
    [{ _id: "tv", title: "Série", kind: "series", status: "active" }],
    [
      {
        _id: "z",
        itemId: "tv",
        season: 1,
        episode: 1,
        watchedAt: new Date("2021-01-01T01:00:00Z"),
      },
    ],
    [],
    "America/Sao_Paulo",
  );
  assert.equal(zoned[0].date, "2020-12-31");
});
test("perfil, seguidores, comparação consentida, compartilhamento e fóruns/votações respeitam acesso", async (t) => {
  const app = await createApp();
  await app.listen(0, "127.0.0.1");
  const db = app.get(getConnectionToken()),
    base = await app.getUrl();
  t.after(async () => {
    try {
      assert.match(database, /^np_communication_[a-f0-9]{32}$/);
      assert.equal(db.name, database);
      await db.dropDatabase();
    } finally {
      await app.close();
    }
  });
  const call = (path, method = "GET", user, body, origin = process.env.CLIENT_ORIGIN) =>
    fetch(base + "/api" + path, {
      method,
      headers: {
        origin,
        ...(user ? { cookie: user.cookie } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const json = async (path, user) => {
    const r = await call(path, "GET", user);
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const register = async (name) => {
    const r = await call("/auth/register", "POST", null, {
      email: name + "@example.test",
      password: "Long-test-password-123!",
    });
    assert.equal(r.status, 201);
    return { id: (await r.json()).user.id, cookie: r.headers.get("set-cookie").split(";")[0] };
  };
  const a = await register("author"),
    b = await register("follower"),
    c = await register("stranger");
  const settings = async (user, body) => {
    const r = await call("/social/settings", "PATCH", user, body);
    assert.equal(r.status, 200);
    return r.json();
  };
  const add = async (user, title, extra = {}) => {
    const r = await call("/library", "POST", user, {
      title,
      kind: "movie",
      status: "planned",
      notes: "PRIVATE",
      ...extra,
    });
    assert.equal(r.status, 201);
    return (await r.json()).item;
  };
  await call("/friends/profile", "POST", a, { name: "author" });
  await settings(a, {
    bio: "Cinema e livros",
    tastes: "Drama",
    favoriteActors: ["Atriz"],
    favoriteDirectors: ["Diretora"],
    favoriteAuthors: ["Autora"],
    isCritic: true,
  });
  assert.equal((await call("/social/profiles/" + a.id, "GET", b)).status, 404);
  for (const bad of [
    { bio: null },
    { bio: "x".repeat(501) },
    { favoriteActors: [""] },
    { favoriteAuthors: Array(11).fill("Autor") },
    { shareComparison: "true" },
    { isCritic: null },
  ])
    assert.equal((await call("/social/settings", "PATCH", a, bad)).status, 400);
  await settings(a, { publicProfile: true });
  const profile = await json("/social/profiles/" + a.id, b);
  assert.equal(profile.bio, "Cinema e livros");
  assert.deepEqual(profile.favoriteDirectors, ["Diretora"]);
  assert.equal(profile.isCritic, true);
  assert.equal((await json("/social/discover?q=author", b)).profiles[0].id, a.id);
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await call("/social/profiles/" + a.id + "/follow", "PATCH", b, { following: true })).status,
      200,
    );
  assert.equal(await db.collection("social_follows").countDocuments(), 1);
  await add(a, "Não compartilha");
  assert.equal((await json("/social/feed", b)).activities.length, 0);
  await settings(a, { shareFollowers: true });
  const film = await add(a, "Compartilhado");
  assert.equal((await json("/social/feed", b)).activities.length, 1);
  assert.equal((await json("/social/feed", c)).activities.length, 0);
  await settings(a, { shareFollowers: false });
  assert.equal((await json("/social/feed", b)).activities.length, 0);
  await settings(a, { shareFollowers: true });
  assert.equal((await json("/social/feed", b)).activities.length, 0);
  const request = await call("/friends/requests", "POST", a, { code: b.id });
  assert.equal(request.status, 204);
  const link = (await json("/friends", b)).connections.find((row) => row.incoming);
  await call("/friends/" + link.id + "/accept", "POST", b);
  const shared = await (await call("/social/share/" + film.id, "POST", a)).json();
  assert.ok(shared.path.startsWith("/compartilhar?obra="));
  assert.equal((await call("/social/shared/" + shared.id, "GET", c)).status, 404);
  const publicTitle = await json("/social/shared/" + shared.id, b);
  assert.equal(JSON.stringify(publicTitle).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(publicTitle).includes(film.id), false);
  assert.equal((await call("/social/profiles/" + a.id + "/compare", "GET", b)).status, 403);
  await settings(a, { shareComparison: true });
  await settings(b, { shareComparison: true });
  await add(a, "Em comum", { status: "completed", completedOn: "2020-01-01", stars: 5 });
  await add(b, "Em comum", { status: "completed", completedOn: "2020-01-01", stars: 3 });
  const comparison = await json("/social/profiles/" + a.id + "/compare", b);
  assert.equal(comparison.commonTitles, 1);
  assert.equal(comparison.ratingAgreement, 50);
  assert.equal(JSON.stringify(comparison).includes("Em comum"), false);
  const topicPayload = {
    title: "O que assistir?",
    text: "Escolha em grupo",
    type: "group-vote",
    scope: "general",
    contextName: "",
    audience: "friends",
    options: ["Filme A", "Filme B"],
    optionType: "title",
    requestId: randomUUID(),
  };
  assert.equal(
    (await call("/community", "POST", a, topicPayload, "https://evil.example")).status,
    403,
  );
  let r = await call("/community", "POST", a, topicPayload);
  assert.equal(r.status, 201);
  let topic = await r.json();
  const path = "/community/" + topic.id;
  assert.equal((await call(path, "GET", c)).status, 404);
  assert.equal((await json("/community", c)).topics.length, 0);
  for (const option of [0, 0, 1]) {
    r = await call(path + "/vote", "PATCH", b, { option });
    assert.equal(r.status, 200);
    topic = await r.json();
  }
  assert.deepEqual(
    topic.options.map((row) => row.count),
    [0, 1],
  );
  assert.equal(topic.myVote, 1);
  assert.equal(JSON.stringify(topic).includes(b.id), false);
  assert.equal((await call(path + "/closed", "PATCH", b, { closed: true })).status, 403);
  const message = { text: "Olá pessoal", spoiler: false, requestId: randomUUID() };
  r = await call(path + "/posts", "POST", b, message);
  assert.equal(r.status, 201);
  topic = await r.json();
  assert.equal(topic.posts[0].spoiler, false);
  await call(path + "/posts", "POST", b, message);
  assert.equal(await db.collection("community_posts").countDocuments(), 1);
  r = await call(path + "/posts", "POST", a, {
    text: "O final revela o assassino",
    spoiler: false,
    parentId: topic.posts[0].id,
    requestId: randomUUID(),
  });
  assert.equal(r.status, 201);
  topic = await r.json();
  assert.equal(topic.posts[1].spoiler, true);
  await db
    .collection("community_posts")
    .insertMany(
      Array.from({ length: 31 }, (_, index) => ({
        _id: new Types.ObjectId(),
        topicId: new Types.ObjectId(topic.id),
        ownerId: new Types.ObjectId(a.id),
        requestId: randomUUID(),
        text: "Antiga " + index,
        spoiler: true,
        parentId: null,
        createdAt: new Date(),
      })),
    );
  const late = await call(path + "/posts", "POST", b, {
    text: "Última mensagem",
    requestId: randomUUID(),
  });
  const lateData = await late.json();
  assert.equal(late.status, 201);
  assert.equal(lateData.posts.length, 30);
  assert.equal(lateData.posted.text, "Última mensagem");
  assert.equal(
    lateData.posts.some((row) => row.id === lateData.posted.id),
    false,
  );
  await call(path + "/closed", "PATCH", a, { closed: true });
  assert.equal((await call(path + "/vote", "PATCH", b, { option: 0 })).status, 400);
  assert.equal(
    (await call(path + "/posts", "POST", b, { ...message, requestId: randomUUID() })).status,
    400,
  );
  for (const type of ["discussion", "theory", "favorites-vote", "duel", "awards"]) {
    const body = {
      ...topicPayload,
      type,
      audience: "community",
      scope: type === "theory" ? "universe" : "general",
      contextName: "Universo",
      options: ["discussion", "theory"].includes(type) ? [] : ["Opção 1", "Opção 2"],
      ...(type === "awards" ? { year: 2026 } : {}),
      requestId: randomUUID(),
    };
    assert.equal((await call("/community", "POST", a, body)).status, 201);
  }
  assert.equal(
    (
      await call("/community", "POST", a, {
        ...topicPayload,
        type: "duel",
        options: ["a", "b", "c"],
        requestId: randomUUID(),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("/community", "POST", a, {
        ...topicPayload,
        type: "discussion",
        scope: "episode",
        itemId: film.id,
        season: 1,
        episode: 1,
        options: [],
        requestId: randomUUID(),
      })
    ).status,
    400,
  );
  assert.equal((await call("/insights")).status, 401);
  const insights = await json("/insights", a);
  assert.equal(insights.years[0].year, "2020");
  assert.ok(insights.allTimeFavorites.length > 0);
  assert.equal((await call("/insights/history?before=bad", "GET", a)).status, 400);
  const ownCompleted = (await json("/library", a)).items.find((item) => item.title === "Em comum");
  assert.equal(
    (
      await call("/insights/annotations/" + ownCompleted.id, "POST", b, {
        actors: [],
        directors: [],
        authors: [],
        franchise: "Teste",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("/insights/annotations/" + ownCompleted.id, "POST", a, {
        actors: ["Ator manual"],
        directors: ["Diretor manual"],
        authors: [],
        franchise: "Franquia manual",
      })
    ).status,
    201,
  );
  const annotated = await json("/insights", a);
  assert.equal(annotated.franchises[0].name, "Franquia manual");
  assert.ok(annotated.creators.some((row) => row.name === "Ator manual" && row.count === 1));
  assert.equal((await json("/insights", b)).annotations.length, 0);
  const activity = await json("/insights/activity", a);
  assert.ok(activity.events.length > 0);
  assert.equal(JSON.stringify(activity).includes("PRIVATE"), false);
  const oldId = film.id;
  await call("/library/" + oldId, "DELETE", a);
  assert.ok(
    (await json("/insights/activity", a)).events.some(
      (row) => row.type === "deleted" && row.title === film.title,
    ),
  );
  assert.equal((await json("/insights/activity", c)).events.length, 0);
  const external = await add(a, "Créditos externos", {
    status: "completed",
    completedOn: "2021-01-01",
  });
  await db
    .collection("library_items")
    .updateOne(
      { _id: new Types.ObjectId(external.id) },
      { $set: { catalogId: "tmdb:movie:1234" } },
    );
  const { CatalogService } = require("../dist/catalog/catalog.module");
  const catalog = app.get(CatalogService);
  catalog.cast = async () => [
    { id: "7:Um", actor: "Atriz externa" },
    { id: "7:Dois", actor: "Atriz externa" },
  ];
  catalog.directors = async () => ({
    directors: [{ id: 8, name: "Diretora externa" }],
    supported: true,
  });
  catalog.franchise = async () => ({ id: 9, name: "Coleção externa" });
  assert.equal((await call("/insights/metadata", "POST", a, { ids: [external.id] })).status, 201);
  assert.equal((await call("/insights/metadata", "POST", b, { ids: [external.id] })).status, 400);
  const enriched = await json("/insights", a);
  assert.equal(enriched.creators.find((row) => row.name === "Atriz externa").count, 1);
  assert.ok(enriched.franchises.some((row) => row.name === "Coleção externa"));
  const history = await json("/insights/history", b);
  assert.equal(
    history.events.some((row) => row.itemId === film.id),
    false,
  );
  await call("/friends/" + link.id, "DELETE", a);
  assert.equal((await call("/social/shared/" + shared.id, "GET", b)).status, 404);
  assert.equal((await call(path, "GET", b)).status, 404);
  assert.equal((await call("/social/profiles/" + a.id + "/compare", "GET", b)).status, 404);
});
