import { Revision } from "@server/models";
import { buildDocument, buildUser } from "@server/test/factories";
import { seed, getTestDatabase, getTestServer } from "@server/test/support";

const db = getTestDatabase();
const server = getTestServer();

afterAll(server.disconnect);

beforeEach(db.flush);

describe("#revisions.info", () => {
  it("should return a document revision", async () => {
    const { user, document } = await seed();
    const revision = await Revision.createFromDocument(document);
    const res = await server.post("/api/revisions.info", {
      body: {
        token: user.getJwtToken(),
        id: revision.id,
      },
    });
    const body = await res.json();
    expect(res.status).toEqual(200);
    expect(body.data.id).not.toEqual(document.id);
    expect(body.data.title).toEqual(document.title);
  });

  it("should require authorization", async () => {
    const document = await buildDocument();
    const revision = await Revision.createFromDocument(document);
    const user = await buildUser();
    const res = await server.post("/api/revisions.info", {
      body: {
        token: user.getJwtToken(),
        id: revision.id,
      },
    });
    expect(res.status).toEqual(403);
  });
});

describe("#revisions.diff", () => {
  it("should return the document HTML if no previous revision", async () => {
    const { user, document } = await seed();
    const revision = await Revision.createFromDocument(document);
    const res = await server.post("/api/revisions.diff", {
      body: {
        token: user.getJwtToken(),
        id: revision.id,
      },
    });
    const body = await res.json();
    expect(res.status).toEqual(200);

    // Can't compare entire HTML output due to generated class names
    expect(body.data).toContain("<html");
    expect(body.data).toContain("<style");
    expect(body.data).toContain("<h1");
    expect(body.data).not.toContain("<ins");
    expect(body.data).not.toContain("<del");
    expect(body.data).toContain(document.title);
  });

  it("should allow returning HTML directly with accept header", async () => {
    const { user, document } = await seed();
    const revision = await Revision.createFromDocument(document);
    const res = await server.post("/api/revisions.diff", {
      body: {
        token: user.getJwtToken(),
        id: revision.id,
      },
      headers: {
        accept: "text/html",
      },
    });
    const body = await res.text();
    expect(res.status).toEqual(200);

    // Can't compare entire HTML output due to generated class names
    expect(body).toContain("<html");
    expect(body).toContain("<style");
    expect(body).toContain("<h1");
    expect(body).not.toContain("<ins");
    expect(body).not.toContain("<del");
    expect(body).toContain(document.title);
  });

  it("should compare to previous revision by default", async () => {
    const { user, document } = await seed();
    await Revision.createFromDocument(document);

    await document.update({ text: "New text" });
    const revision1 = await Revision.createFromDocument(document);

    const res = await server.post("/api/revisions.diff", {
      body: {
        token: user.getJwtToken(),
        id: revision1.id,
      },
    });
    const body = await res.json();
    expect(res.status).toEqual(200);

    // Can't compare entire HTML output due to generated class names
    expect(body.data).toContain("<html");
    expect(body.data).toContain("<style");
    expect(body.data).toContain("<h1");
    expect(body.data).toContain("<ins");
    expect(body.data).toContain("<del");
    expect(body.data).toContain(document.title);
  });

  it("should require authorization", async () => {
    const document = await buildDocument();
    const revision = await Revision.createFromDocument(document);
    const user = await buildUser();
    const res = await server.post("/api/revisions.diff", {
      body: {
        token: user.getJwtToken(),
        id: revision.id,
      },
    });
    expect(res.status).toEqual(403);
  });
});

describe("#revisions.list", () => {
  it("should return a document's revisions", async () => {
    const { user, document } = await seed();
    await Revision.createFromDocument(document);
    const res = await server.post("/api/revisions.list", {
      body: {
        token: user.getJwtToken(),
        documentId: document.id,
      },
    });
    const body = await res.json();
    expect(res.status).toEqual(200);
    expect(body.data.length).toEqual(1);
    expect(body.data[0].id).not.toEqual(document.id);
    expect(body.data[0].title).toEqual(document.title);
  });

  it("should not return revisions for document in collection not a member of", async () => {
    const { user, document, collection } = await seed();
    await Revision.createFromDocument(document);
    collection.permission = null;
    await collection.save();
    const res = await server.post("/api/revisions.list", {
      body: {
        token: user.getJwtToken(),
        documentId: document.id,
      },
    });
    expect(res.status).toEqual(403);
  });

  it("should require authorization", async () => {
    const document = await buildDocument();
    const user = await buildUser();
    const res = await server.post("/api/revisions.list", {
      body: {
        token: user.getJwtToken(),
        documentId: document.id,
      },
    });
    expect(res.status).toEqual(403);
  });
});
