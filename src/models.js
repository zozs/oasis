"use strict";

const debug = require("debug")("oasis");
const { isRoot, isReply: isComment } = require("ssb-thread-schema");
const lodash = require("lodash");
const prettyMs = require("pretty-ms");
const pullParallelMap = require("pull-paramap");
const pull = require("pull-stream");
const pullSort = require("pull-sort");
const ssbRef = require("ssb-ref");
const crypto = require("crypto");

const isEncrypted = (message) => typeof message.value.content === "string";
const isNotEncrypted = (message) => isEncrypted(message) === false;

const isDecrypted = (message) =>
  lodash.get(message, "value.meta.private", false);

const isPrivate = (message) => isEncrypted(message) || isDecrypted(message);

const isNotPrivate = (message) => isPrivate(message) === false;

const hasRoot = (message) =>
  ssbRef.isMsg(lodash.get(message, "value.content.root", null));

const hasFork = (message) =>
  ssbRef.isMsg(lodash.get(message, "value.content.fork", null));

const hasNoRoot = (message) => hasRoot(message) === false;
const hasNoFork = (message) => hasFork(message) === false;

const isPost = (message) =>
  lodash.get(message, "value.content.type") === "post" &&
  typeof lodash.get(message, "value.content.text") === "string";

// HACK: https://github.com/ssbc/ssb-thread-schema/issues/4
const isSubtopic = require("ssb-thread-schema/post/nested-reply/validator");

const nullImage = `&${"0".repeat(43)}=.sha256`;

const defaultOptions = {
  private: true,
  reverse: true,
  meta: true,
};

const publicOnlyFilter = pull.filter(isNotPrivate);

/** @param {object[]} customOptions */
const configure = (...customOptions) =>
  Object.assign({}, defaultOptions, ...customOptions);

module.exports = ({ cooler, isPublic }) => {
  const models = {};

  /**
   * The SSB-About plugin is a thin wrapper around the SSB-Social-Index plugin.
   * Unfortunately, this plugin has two problems that make it incompatible with
   * our needs:
   *
   * - We want to get the latest value from an author, like what someone calls
   *   themselves, **not what other people call them**.
   * - The plugin has a bug where `false` isn't handled correctly, which is very
   *   important since we use `publicWebHosting`, a boolean field.
   *
   * It feels very silly to have to maintain an alternative implementation of
   * SSB-About, but this is much smaller code and doesn't have either of the
   * above problems. Maybe this should be moved somewhere else in the future?
   */
  const getAbout = async ({ key, feedId }) => {
    const ssb = await cooler.open();

    const source = ssb.backlinks.read({
      reverse: true,
      query: [
        {
          $filter: {
            dest: feedId,
            value: {
              author: feedId,
              content: { type: "about", about: feedId },
            },
          },
        },
      ],
    });
    return new Promise((resolve, reject) =>
      pull(
        source,
        pull.find(
          (message) => message.value.content[key] !== undefined,
          (err, message) => {
            if (err) {
              reject(err);
            } else {
              if (message === null) {
                resolve(null);
              } else {
                resolve(message.value.content[key]);
              }
            }
          }
        )
      )
    );
  };

  models.about = {
    publicWebHosting: async (feedId) => {
      const result = await getAbout({
        key: "publicWebHosting",
        feedId,
      });
      return result === true;
    },
    name: async (feedId) => {
      if (isPublic && (await models.about.publicWebHosting(feedId)) === false) {
        return "Redacted";
      }

      return (
        (await getAbout({
          key: "name",
          feedId,
        })) || feedId.slice(1, 1 + 8)
      ); // First 8 chars of public key
    },
    image: async (feedId) => {
      if (isPublic && (await models.about.publicWebHosting(feedId)) === false) {
        return nullImage;
      }

      const raw = await getAbout({
        key: "image",
        feedId,
      });

      if (raw == null || raw.link == null) {
        return nullImage;
      }

      if (typeof raw.link === "string") {
        return raw.link;
      }
      return raw;
    },
    description: async (feedId) => {
      if (isPublic && (await models.about.publicWebHosting(feedId)) === false) {
        return "Redacted";
      }

      const raw =
        (await getAbout({
          key: "description",
          feedId,
        })) || "";
      return raw;
    },
  };

  models.blob = {
    get: async ({ blobId }) => {
      debug("get blob: %s", blobId);
      const ssb = await cooler.open();
      return ssb.blobs.get(blobId);
    },
    ls: async () => {
      const ssb = await cooler.open();
      return ssb.blobs.ls();
    },
    want: async ({ blobId }) => {
      debug("want blob: %s", blobId);
      const ssb = await cooler.open();

      // This does not wait for the blob.
      ssb.blobs.want(blobId);
    },
    search: async ({ query }) => {
      debug("blob search: %s", query);
      const ssb = await cooler.open();

      return new Promise((resolve, reject) => {
        ssb.meme.search(query, (err, blobs) => {
          if (err) return reject(err);

          return resolve(blobs);
        });
      });
    },
  };

  models.friend = {
    /** @param {{ feedId: string, following: boolean, blocking: boolean }} input */
    setRelationship: async ({ feedId, following, blocking }) => {
      if (following && blocking) {
        throw new Error("Cannot follow and block at the same time");
      }

      const current = await models.friend.getRelationship(feedId);
      const alreadySet =
        current.following === following && current.blocking === blocking;

      if (alreadySet) {
        // The following state is already set, don't re-set it.
        return;
      }

      const ssb = await cooler.open();

      const content = {
        type: "contact",
        contact: feedId,
        following,
        blocking,
      };

      return ssb.publish(content);
    },
    follow: (feedId) =>
      models.friend.setRelationship({
        feedId,
        following: true,
        blocking: false,
      }),
    unfollow: (feedId) =>
      models.friend.setRelationship({
        feedId,
        following: false,
        blocking: false,
      }),
    block: (feedId) =>
      models.friend.setRelationship({
        feedId,
        blocking: true,
        following: false,
      }),
    unblock: (feedId) =>
      models.friend.setRelationship({
        feedId,
        blocking: false,
        following: false,
      }),
    /**
     * @param feedId {string}
     * @returns {Promise<{me: boolean, following: boolean, blocking: boolean }>}
     */
    getRelationship: async (feedId) => {
      const ssb = await cooler.open();
      const { id } = ssb;

      if (feedId === id) {
        return { me: true, following: false, blocking: false };
      }

      const isFollowing = await ssb.friends.isFollowing({
        source: id,
        dest: feedId,
      });

      const isBlocking = await ssb.friends.isBlocking({
        source: id,
        dest: feedId,
      });

      return {
        me: false,
        following: isFollowing,
        blocking: isBlocking,
      };
    },
  };

  models.meta = {
    myFeedId: async () => {
      const ssb = await cooler.open();
      const { id } = ssb;
      return id;
    },
    get: async (msgId) => {
      const ssb = await cooler.open();
      return ssb.get({
        id: msgId,
        meta: true,
        private: true,
      });
    },
    status: async () => {
      const ssb = await cooler.open();
      return ssb.status();
    },
    peers: async () => {
      const ssb = await cooler.open();
      const peersSource = await ssb.conn.peers();

      return new Promise((resolve, reject) => {
        pull(
          peersSource,
          // https://github.com/staltz/ssb-conn/issues/9
          pull.take(1),
          pull.collect((err, val) => {
            if (err) return reject(err);
            resolve(val[0]);
          })
        );
      });
    },
    connectedPeers: async () => {
      const peers = await models.meta.peers();
      return peers.filter(([address, data]) => {
        if (data.state === "connected") {
          return [address, data];
        }
      });
    },
    connStop: async () => {
      const ssb = await cooler.open();

      try {
        const result = await ssb.conn.stop();
        return result;
      } catch (e) {
        const expectedName = "TypeError";
        const expectedMessage = "Cannot read property 'close' of null";
        if (e.name === expectedName && e.message === expectedMessage) {
          // https://github.com/staltz/ssb-lan/issues/5
          debug("ssbConn is already stopped -- caught error");
        } else {
          throw new Error(e);
        }
      }
    },
    connStart: async () => {
      const ssb = await cooler.open();
      const result = await ssb.conn.start();

      return result;
    },
    connRestart: async () => {
      await models.meta.connStop();
      await models.meta.connStart();
    },
    sync: async () => {
      const ssb = await cooler.open();

      const progress = await ssb.progress();
      let previousTarget = progress.indexes.target;

      // Automatically timeout after 5 minutes.
      let keepGoing = true;
      const timeoutInterval = setTimeout(() => {
        keepGoing = false;
      }, 5 * 60 * 1000);

      await ssb.conn.start();

      // Promise that resolves the number of new messages after 5 seconds.
      const diff = async () =>
        new Promise((resolve) => {
          setTimeout(async () => {
            const currentProgress = await ssb.progress();
            const currentTarget = currentProgress.indexes.target;
            const difference = currentTarget - previousTarget;
            previousTarget = currentTarget;
            debug(`Difference: ${difference} bytes`);
            resolve(difference);
          }, 5000);
        });

      debug("Starting sync, waiting for new messages...");

      // Wait until we **start** receiving messages.
      while (keepGoing && (await diff()) === 0) {
        debug("Received no new messages.");
      }

      debug("Finished waiting for first new message.");

      // Wait until we **stop** receiving messages.
      while (keepGoing && (await diff()) > 0) {
        debug(`Still receiving new messages...`);
      }

      debug("Finished waiting for last new message.");

      clearInterval(timeoutInterval);

      await ssb.conn.stop();
    },
    acceptInvite: async (invite) => {
      const ssb = await cooler.open();
      return await ssb.invite.accept(invite);
    },
  };

  const isLooseRoot = (message) => {
    const conditions = [
      isPost(message),
      hasNoRoot(message),
      hasNoFork(message),
    ];

    return conditions.every((x) => x);
  };

  const isLooseSubtopic = (message) => {
    const conditions = [isPost(message), hasRoot(message), hasFork(message)];

    return conditions.every((x) => x);
  };

  const isLooseComment = (message) => {
    const conditions = [isPost(message), hasRoot(message), hasNoFork(message)];

    return conditions.every((x) => x === true);
  };

  const maxMessages = 64;

  const getMessages = async ({
    myFeedId,
    customOptions,
    ssb,
    query,
    filter = null,
  }) => {
    const options = configure({ query, index: "DTA" }, customOptions);

    const source = ssb.backlinks.read(options);
    const basicSocialFilter = await socialFilter();

    return new Promise((resolve, reject) => {
      pull(
        source,
        basicSocialFilter,
        pull.filter(
          (msg) =>
            isNotEncrypted(msg) &&
            isPost(msg) &&
            (filter == null || filter(msg) === true)
        ),
        pull.take(maxMessages),
        pull.collect((err, collectedMessages) => {
          if (err) {
            reject(err);
          } else {
            resolve(transform(ssb, collectedMessages, myFeedId));
          }
        })
      );
    });
  };

  /**
   * Returns a function that filters messages based on who published the message.
   *
   * `null` means we don't care, `true` means it must be true, and `false` means
   * that the value must be false. For example, if you set `me = true` then it
   * will only allow messages that are from you. If you set `blocking = true`
   * then you only see message from people you block.
   */
  const socialFilter = async ({
    following = null,
    blocking = false,
    me = null,
  } = {}) => {
    const ssb = await cooler.open();
    const { id } = ssb;
    const relationshipObject = await ssb.friends.get({
      source: id,
    });

    const followingList = Object.entries(relationshipObject)
      .filter(([, val]) => val === true)
      .map(([key]) => key);

    const blockingList = Object.entries(relationshipObject)
      .filter(([, val]) => val === false)
      .map(([key]) => key);

    return pull.filter((message) => {
      if (message.value.author === id) {
        return me !== false;
      } else {
        return (
          (following === null ||
            followingList.includes(message.value.author) === following) &&
          (blocking === null ||
            blockingList.includes(message.value.author) === blocking)
        );
      }
    });
  };
  const transform = (ssb, messages, myFeedId) =>
    Promise.all(
      messages.map(async (msg) => {
        debug("transforming %s", msg.key);

        if (msg == null) {
          return null;
        }

        const filterQuery = {
          $filter: {
            dest: msg.key,
          },
        };

        const referenceStream = ssb.backlinks.read({
          query: [filterQuery],
          index: "DTA", // use asserted timestamps
          private: true,
          meta: true,
        });

        const rawVotes = await new Promise((resolve, reject) => {
          pull(
            referenceStream,
            pull.filter(
              (ref) =>
                isNotEncrypted(ref) &&
                ref.value.content.type === "vote" &&
                ref.value.content.vote &&
                typeof ref.value.content.vote.value === "number" &&
                ref.value.content.vote.value >= 0 &&
                ref.value.content.vote.link === msg.key
            ),
            pull.collect((err, collectedMessages) => {
              if (err) {
                reject(err);
              } else {
                resolve(collectedMessages);
              }
            })
          );
        });

        // { @key: 1, @key2: 0, @key3: 1 }
        //
        // only one vote per person!
        const reducedVotes = rawVotes.reduce((acc, vote) => {
          acc[vote.value.author] = vote.value.content.vote.value;
          return acc;
        }, {});

        // gets *only* the people who voted 1
        // [ @key, @key, @key ]
        const voters = Object.entries(reducedVotes)
          .filter(([, value]) => value === 1)
          .map(([key]) => key);

        // get an array of voter names, for display on hover
        const pendingVoterNames = voters.map((author) =>
          models.about.name(author)
        );
        const voterNames = await Promise.all(pendingVoterNames);

        const pendingName = models.about.name(msg.value.author);
        const pendingAvatarMsg = models.about.image(msg.value.author);

        const pending = [pendingName, pendingAvatarMsg];
        const [name, avatarMsg] = await Promise.all(pending);

        if (isPublic) {
          const publicOptIn = await models.about.publicWebHosting(
            msg.value.author
          );
          if (publicOptIn === false) {
            lodash.set(
              msg,
              "value.content.text",
              "This is a public message that has been redacted because Oasis is running in public mode. This redaction is only meant to make Oasis consistent with other public SSB viewers. Please do not mistake this for privacy. All public messages are public. Any peer on the SSB network can see this message."
            );

            if (msg.value.content.contentWarning != null) {
              msg.value.content.contentWarning = "Redacted";
            }
          }
        }

        const channel = lodash.get(msg, "value.content.channel");
        const hasChannel = typeof channel === "string" && channel.length > 2;

        if (hasChannel && hasNoRoot(msg)) {
          msg.value.content.text += `\n\n#${channel}`;
        }

        const avatarId =
          avatarMsg != null && typeof avatarMsg.link === "string"
            ? avatarMsg.link || nullImage
            : avatarMsg || nullImage;

        const avatarUrl = `/image/64/${encodeURIComponent(avatarId)}`;

        const ts = new Date(msg.value.timestamp);
        let isoTs;

        try {
          isoTs = ts.toISOString();
        } catch (e) {
          // Just in case it's an invalid date. :(
          debug(e);
          const receivedTs = new Date(msg.timestamp);
          isoTs = receivedTs.toISOString();
        }

        lodash.set(msg, "value.meta.timestamp.received.iso8601", isoTs);

        const ago = Date.now() - Number(ts);
        const prettyAgo = prettyMs(ago, { compact: true });
        lodash.set(msg, "value.meta.timestamp.received.since", prettyAgo);
        lodash.set(msg, "value.meta.author.name", name);
        lodash.set(msg, "value.meta.author.avatar", {
          id: avatarId,
          url: avatarUrl,
        });

        if (isPost(msg) && hasNoRoot(msg) && hasNoFork(msg)) {
          lodash.set(msg, "value.meta.postType", "post");
        } else if (isPost(msg) && hasRoot(msg) && hasNoFork(msg)) {
          lodash.set(msg, "value.meta.postType", "comment");
        } else if (isPost(msg) && hasRoot(msg) && hasFork(msg)) {
          lodash.set(msg, "value.meta.postType", "subtopic");
        } else {
          lodash.set(msg, "value.meta.postType", "mystery");
        }

        lodash.set(msg, "value.meta.votes", voterNames);
        lodash.set(msg, "value.meta.voted", voters.includes(myFeedId));

        return msg;
      })
    );

  const post = {
    fromPublicFeed: async (feedId, customOptions = {}) => {
      const ssb = await cooler.open();

      const myFeedId = ssb.id;

      const options = configure({ id: feedId }, customOptions);

      const { blocking } = await models.friend.getRelationship(feedId);

      // Avoid streaming any messages from this feed. If we used the social
      // filter here it would continue streaming all messages from this author
      // until it consumed the entire feed.
      if (blocking) {
        return [];
      }

      const source = ssb.createUserStream(options);

      const messages = await new Promise((resolve, reject) => {
        pull(
          source,
          pull.filter((msg) => isDecrypted(msg) === false && isPost(msg)),
          pull.take(maxMessages),
          pull.collect((err, collectedMessages) => {
            if (err) {
              reject(err);
            } else {
              resolve(transform(ssb, collectedMessages, myFeedId));
            }
          })
        );
      });

      return messages;
    },
    mentionsMe: async (customOptions = {}) => {
      const ssb = await cooler.open();

      const myFeedId = ssb.id;

      const query = [
        {
          $filter: {
            dest: myFeedId,
          },
        },
      ];

      const messages = await getMessages({
        myFeedId,
        customOptions,
        ssb,
        query,
        filter: (msg) =>
          msg.value.author !== myFeedId &&
          lodash.get(msg, "value.meta.private") !== true,
      });

      return messages;
    },
    fromHashtag: async (hashtag, customOptions = {}) => {
      const ssb = await cooler.open();

      const myFeedId = ssb.id;

      const query = [
        {
          $filter: {
            dest: `#${hashtag}`,
          },
        },
      ];

      const messages = await getMessages({
        myFeedId,
        customOptions,
        ssb,
        query,
      });

      return messages;
    },
    topicComments: async (rootId, customOptions = {}) => {
      const ssb = await cooler.open();

      const myFeedId = ssb.id;

      const query = [
        {
          $filter: {
            dest: rootId,
          },
        },
      ];

      const messages = await getMessages({
        myFeedId,
        customOptions,
        ssb,
        query,
        filter: (msg) => msg.value.content.root === rootId && hasNoFork(msg),
      });

      return messages;
    },
    likes: async ({ feed }, customOptions = {}) => {
      const ssb = await cooler.open();

      const query = [
        {
          $filter: {
            value: {
              author: feed,
              timestamp: { $lte: Date.now() },
              content: {
                type: "vote",
              },
            },
          },
        },
      ];

      const options = configure(
        {
          query,
          reverse: true,
        },
        customOptions
      );

      const source = await ssb.query.read(options);

      const messages = await new Promise((resolve, reject) => {
        pull(
          source,
          pull.filter((msg) => {
            return (
              isNotEncrypted(msg) &&
              msg.value.author === feed &&
              typeof msg.value.content.vote === "object" &&
              typeof msg.value.content.vote.link === "string"
            );
          }),
          pull.take(maxMessages),
          pullParallelMap(async (val, cb) => {
            const msg = await post.get(val.value.content.vote.link);
            cb(null, msg);
          }),
          pull.collect((err, collectedMessages) => {
            if (err) {
              reject(err);
            } else {
              resolve(collectedMessages);
            }
          })
        );
      });

      return messages;
    },
    search: async ({ query }) => {
      const ssb = await cooler.open();

      const myFeedId = ssb.id;

      const options = configure({
        query,
      });

      const source = await ssb.search.query(options);
      const basicSocialFilter = await socialFilter();

      const messages = await new Promise((resolve, reject) => {
        pull(
          source,
          basicSocialFilter,
          pull.filter(isNotPrivate),
          pull.take(maxMessages),
          pull.collect((err, collectedMessages) => {
            if (err) {
              reject(err);
            } else {
              resolve(transform(ssb, collectedMessages, myFeedId));
            }
          })
        );
      });

      return messages;
    },
    latest: async () => {
      const ssb = await cooler.open();

      const myFeedId = ssb.id;

      const source = ssb.query.read(
        configure({
          query: [
            {
              $filter: {
                value: {
                  timestamp: { $lte: Date.now() },
                  content: {
                    type: "post",
                  },
                },
              },
            },
          ],
        })
      );
      const followingFilter = await socialFilter({ following: true });

      const messages = await new Promise((resolve, reject) => {
        pull(
          source,
          followingFilter,
          publicOnlyFilter,
          pull.take(maxMessages),
          pull.collect((err, collectedMessages) => {
            if (err) {
              reject(err);
            } else {
              resolve(transform(ssb, collectedMessages, myFeedId));
            }
          })
        );
      });

      return messages;
    },
    latestExtended: async () => {
      const ssb = await cooler.open();

      const myFeedId = ssb.id;

      const source = ssb.query.read(
        configure({
          query: [
            {
              $filter: {
                value: {
                  timestamp: { $lte: Date.now() },
                  content: {
                    type: "post",
                  },
                },
              },
            },
          ],
        })
      );

      const extendedFilter = await socialFilter({
        following: false,
        me: false,
      });

      const messages = await new Promise((resolve, reject) => {
        pull(
          source,
          publicOnlyFilter,
          extendedFilter,
          pull.take(maxMessages),
          pull.collect((err, collectedMessages) => {
            if (err) {
              reject(err);
            } else {
              resolve(transform(ssb, collectedMessages, myFeedId));
            }
          })
        );
      });

      return messages;
    },
    latestTopics: async () => {
      const ssb = await cooler.open();

      const myFeedId = ssb.id;

      const source = ssb.query.read(
        configure({
          query: [
            {
              $filter: {
                value: {
                  timestamp: { $lte: Date.now() },
                  content: {
                    type: "post",
                  },
                },
              },
            },
          ],
        })
      );

      const extendedFilter = await socialFilter({
        following: true,
      });

      const messages = await new Promise((resolve, reject) => {
        pull(
          source,
          publicOnlyFilter,
          pull.filter(hasNoRoot),
          extendedFilter,
          pull.take(maxMessages),
          pull.collect((err, collectedMessages) => {
            if (err) {
              reject(err);
            } else {
              resolve(transform(ssb, collectedMessages, myFeedId));
            }
          })
        );
      });

      return messages;
    },
    latestSummaries: async () => {
      const ssb = await cooler.open();

      const myFeedId = ssb.id;

      const options = configure({
        type: "post",
        private: false,
      });

      const source = ssb.messagesByType(options);

      const extendedFilter = await socialFilter({
        following: true,
      });

      const messages = await new Promise((resolve, reject) => {
        pull(
          source,
          pull.filter((message) => isNotPrivate(message) && hasNoRoot(message)),
          extendedFilter,
          pull.take(maxMessages),
          pullParallelMap(async (message, cb) => {
            // Retrieve a preview of this post's comments / thread
            const thread = await post.fromThread(message.key);
            lodash.set(
              message,
              "value.meta.thread",
              await transform(ssb, thread, myFeedId)
            );
            cb(null, message);
          }),
          pull.collect((err, collectedMessages) => {
            if (err) {
              reject(err);
            } else {
              resolve(transform(ssb, collectedMessages, myFeedId));
            }
          })
        );
      });

      return messages;
    },
    latestThreads: async () => {
      const ssb = await cooler.open();

      const myFeedId = ssb.id;

      const source = ssb.query.read(
        configure({
          query: [
            {
              $filter: {
                value: {
                  timestamp: { $lte: Date.now() },
                  content: {
                    type: "post",
                  },
                },
              },
            },
          ],
        })
      );

      const messages = await new Promise((resolve, reject) => {
        pull(
          source,
          pull.filter((message) => isNotPrivate(message) && hasNoRoot(message)),
          pull.take(maxMessages),
          pullParallelMap(async (message, cb) => {
            // Retrieve a preview of this post's comments / thread
            const thread = await post.fromThread(message.key);
            lodash.set(
              message,
              "value.meta.thread",
              await transform(ssb, thread, myFeedId)
            );
            cb(null, message);
          }),
          pull.filter((message) => message.value.meta.thread.length > 1),
          pull.collect((err, collectedMessages) => {
            if (err) {
              reject(err);
            } else {
              resolve(transform(ssb, collectedMessages, myFeedId));
            }
          })
        );
      });

      return messages;
    },

    popular: async ({ period }) => {
      const ssb = await cooler.open();

      const periodDict = {
        day: 1,
        week: 7,
        month: 30.42,
        year: 365,
      };

      if (period in periodDict === false) {
        throw new Error("invalid period");
      }

      const myFeedId = ssb.id;

      const now = new Date();
      const earliest = Number(now) - 1000 * 60 * 60 * 24 * periodDict[period];

      const source = ssb.query.read(
        configure({
          query: [
            {
              $filter: {
                value: {
                  timestamp: { $gte: earliest },
                  content: {
                    type: "vote",
                  },
                },
              },
            },
          ],
        })
      );
      const basicSocialFilter = await socialFilter();

      const messages = await new Promise((resolve, reject) => {
        pull(
          source,
          publicOnlyFilter,
          pull.filter((msg) => {
            return (
              isNotEncrypted(msg) &&
              typeof msg.value.content.vote === "object" &&
              typeof msg.value.content.vote.link === "string" &&
              typeof msg.value.content.vote.value === "number"
            );
          }),
          pull.reduce(
            (acc, cur) => {
              const author = cur.value.author;
              const target = cur.value.content.vote.link;
              const value = cur.value.content.vote.value;

              if (acc[author] == null) {
                acc[author] = {};
              }

              // Only accept values between -1 and 1
              acc[author][target] = Math.max(-1, Math.min(1, value));

              return acc;
            },
            {},
            (err, obj) => {
              if (err) {
                return reject(err);
              }

              // HACK: Can we do this without a reduce()? I think this makes the
              // stream much slower than it needs to be. Also, we should probably
              // be indexing these rather than building the stream on refresh.

              const adjustedObj = Object.entries(obj).reduce(
                (acc, [author, values]) => {
                  if (author === myFeedId) {
                    return acc;
                  }

                  // The value of a users vote is 1 / (1 + total votes), the
                  // more a user votes, the less weight is given to each vote.

                  const entries = Object.entries(values);
                  const total = 1 + Math.log(entries.length);

                  entries.forEach(([link, value]) => {
                    if (acc[link] == null) {
                      acc[link] = 0;
                    }
                    acc[link] += value / total;
                  });
                  return acc;
                },
                []
              );

              const arr = Object.entries(adjustedObj);
              const length = arr.length;

              pull(
                pull.values(arr),
                pullSort(([, aVal], [, bVal]) => bVal - aVal),
                pull.take(Math.min(length, maxMessages)),
                pull.map(([key]) => key),
                pullParallelMap(async (key, cb) => {
                  try {
                    const msg = await post.get(key);
                    cb(null, msg);
                  } catch (e) {
                    cb(null, null);
                  }
                }),
                // avoid private messages (!) and non-posts
                pull.filter(
                  (message) =>
                    message &&
                    isNotPrivate(message) &&
                    message.value.content.type === "post"
                ),
                basicSocialFilter,
                pull.collect((collectErr, collectedMessages) => {
                  if (collectErr) {
                    reject(collectErr);
                  } else {
                    resolve(collectedMessages);
                  }
                })
              );
            }
          )
        );
      });

      return messages;
    },
    fromThread: async (msgId, customOptions) => {
      debug("thread: %s", msgId);
      const ssb = await cooler.open();

      const myFeedId = ssb.id;

      const options = configure({ id: msgId }, customOptions);
      return ssb
        .get(options)
        .then(async (rawMsg) => {
          debug("got raw message");

          const parents = [];

          const getRootAncestor = (msg) =>
            new Promise((resolve, reject) => {
              if (msg.key == null) {
                debug("something is very wrong, we used `{ meta: true }`");
                resolve(parents);
              } else {
                debug("getting root ancestor of %s", msg.key);

                if (isEncrypted(msg)) {
                  // Private message we can't decrypt, stop looking for parents.
                  debug("private message");
                  if (parents.length > 0) {
                    // If we already have some parents, return those.
                    resolve(parents);
                  } else {
                    // If we don't know of any parents, resolve this message.
                    resolve(msg);
                  }
                } else if (msg.value.content.type !== "post") {
                  debug("not a post");
                  resolve(msg);
                } else if (
                  isLooseSubtopic(msg) &&
                  ssbRef.isMsg(msg.value.content.fork)
                ) {
                  debug("subtopic, get the parent");
                  try {
                    // It's a subtopic, get the parent!
                    ssb
                      .get({
                        id: msg.value.content.fork,
                        meta: true,
                        private: true,
                      })
                      .then((fork) => {
                        resolve(getRootAncestor(fork));
                      })
                      .catch(reject);
                  } catch (e) {
                    debug(e);
                    resolve(msg);
                  }
                } else if (
                  isLooseComment(msg) &&
                  ssbRef.isMsg(msg.value.content.root)
                ) {
                  debug("comment: %s", msg.value.content.root);
                  try {
                    // It's a thread subtopic, get the parent!
                    ssb
                      .get({
                        id: msg.value.content.root,
                        meta: true,
                        private: true,
                      })
                      .then((root) => {
                        resolve(getRootAncestor(root));
                      })
                      .catch(reject);
                  } catch (e) {
                    debug(e);
                    resolve(msg);
                  }
                } else if (isLooseRoot(msg)) {
                  debug("got root ancestor");
                  resolve(msg);
                } else {
                  // type !== "post", probably
                  // this should show up as JSON
                  debug(
                    "got mysterious root ancestor that fails all known schemas"
                  );
                  debug("%O", msg);
                  resolve(msg);
                }
              }
            });

          const getDirectDescendants = (key) =>
            new Promise((resolve, reject) => {
              const filterQuery = {
                $filter: {
                  dest: key,
                },
              };

              const referenceStream = ssb.backlinks.read({
                query: [filterQuery],
                index: "DTA", // use asserted timestamps
              });
              pull(
                referenceStream,
                pull.filter((msg) => {
                  if (isPost(msg) === false) {
                    return false;
                  }

                  const root = lodash.get(msg, "value.content.root");
                  const fork = lodash.get(msg, "value.content.fork");

                  if (root !== key && fork !== key) {
                    // mention
                    return false;
                  }

                  if (fork === key) {
                    // not a subtopic of this post
                    // it's a subtopic **of a subtopic** of this post
                    return false;
                  }

                  return true;
                }),
                pull.collect((err, messages) => {
                  if (err) {
                    reject(err);
                  } else {
                    resolve(messages || undefined);
                  }
                })
              );
            });

          // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/flat
          const flattenDeep = (arr1) =>
            arr1.reduce(
              (acc, val) =>
                Array.isArray(val)
                  ? acc.concat(flattenDeep(val))
                  : acc.concat(val),
              []
            );

          const getDeepDescendants = (key) =>
            new Promise((resolve, reject) => {
              const oneDeeper = async (descendantKey, depth) => {
                const descendants = await getDirectDescendants(descendantKey);

                if (descendants.length === 0) {
                  return descendants;
                }

                return Promise.all(
                  descendants.map(async (descendant) => {
                    const deeperDescendants = await oneDeeper(
                      descendant.key,
                      depth + 1
                    );
                    lodash.set(descendant, "value.meta.thread.depth", depth);
                    lodash.set(descendant, "value.meta.thread.subtopic", true);
                    return [descendant, deeperDescendants];
                  })
                );
              };
              oneDeeper(key, 0)
                .then((nested) => {
                  const nestedDescendants = [...nested];
                  const deepDescendants = flattenDeep(nestedDescendants);
                  resolve(deepDescendants);
                })
                .catch(reject);
            });

          const rootAncestor = await getRootAncestor(rawMsg);
          const deepDescendants = await getDeepDescendants(rootAncestor.key);

          const allMessages = [rootAncestor, ...deepDescendants].map(
            (message) => {
              const isThreadTarget = message.key === msgId;
              lodash.set(message, "value.meta.thread.target", isThreadTarget);
              return message;
            }
          );

          return await transform(ssb, allMessages, myFeedId);
        })
        .catch((err) => {
          if (err.name === "NotFoundError") {
            throw new Error(
              "Message not found in the database. You've done nothing wrong. Maybe try again later?"
            );
          } else {
            throw err;
          }
        });
    },
    get: async (msgId, customOptions) => {
      debug("get: %s", msgId);
      const ssb = await cooler.open();

      const myFeedId = ssb.id;

      const options = configure({ id: msgId }, customOptions);
      const rawMsg = await ssb.get(options);
      debug("got raw message");

      const transformed = await transform(ssb, [rawMsg], myFeedId);
      debug("transformed: %O", transformed);
      return transformed[0];
    },
    publish: async (options) => {
      const ssb = await cooler.open();
      const body = { type: "post", ...options };

      debug("Published: %O", body);
      return ssb.publish(body);
    },
    publishProfileEdit: async ({ name, description, image }) => {
      const ssb = await cooler.open();
      if (image.length > 0) {
        // 5 MiB check
        const mebibyte = Math.pow(2, 20);
        const maxSize = 5 * mebibyte;
        if (image.length > maxSize) {
          throw new Error("Image file is too big, maximum size is 5 mebibytes");
        }
        const algorithm = "sha256";
        const hash = crypto
          .createHash(algorithm)
          .update(image)
          .digest("base64");

        const blobId = `&${hash}.${algorithm}`;
        return new Promise((resolve, reject) => {
          pull(
            pull.values([image]),
            ssb.blobs.add(blobId, (err) => {
              if (err) {
                reject(err);
              } else {
                const body = {
                  type: "about",
                  about: ssb.id,
                  name,
                  description,
                  image: blobId,
                };
                debug("Published: %O", body);
                resolve(ssb.publish(body));
              }
            })
          );
        });
      } else {
        const body = { type: "about", about: ssb.id, name, description };
        debug("Published: %O", body);
        return ssb.publish(body);
      }
    },
    publishCustom: async (options) => {
      const ssb = await cooler.open();
      debug("Published: %O", options);
      return ssb.publish(options);
    },
    subtopic: async ({ parent, message }) => {
      message.root = parent.key;
      message.fork = lodash.get(parent, "value.content.root");
      message.branch = await post.branch({ root: parent.key });
      message.type = "post"; // redundant but used for validation

      if (isSubtopic(message) !== true) {
        const messageString = JSON.stringify(message, null, 2);
        throw new Error(`message should be valid subtopic: ${messageString}`);
      }

      return post.publish(message);
    },
    root: async (options) => {
      const message = { type: "post", ...options };

      if (isRoot(message) !== true) {
        const messageString = JSON.stringify(message, null, 2);
        throw new Error(`message should be valid root post: ${messageString}`);
      }

      return post.publish(message);
    },
    comment: async ({ parent, message }) => {
      // Set `root` to `parent`'s root.
      // If `parent` doesn't have a root, use the parent's key.
      // If `parent` has a fork, you must use the parent's key.
      const parentKey = parent.key;
      const parentFork = lodash.get(parent, "value.content.fork");
      const parentRoot = lodash.get(parent, "value.content.root", parentKey);

      if (isDecrypted(parent)) {
        message.recps = lodash
          .get(parent, "value.content.recps", [])
          .map((recipient) => {
            if (
              typeof recipient === "object" &&
              typeof recipient.link === "string" &&
              recipient.link.length
            ) {
              // Some interfaces, like Patchbay, put `{ name, link }` objects in
              // `recps`. The comment schema says this is invalid, so we want to
              // fix the `recps` before publishing.
              return recipient.link;
            } else {
              return recipient;
            }
          });

        if (message.recps.length === 0) {
          throw new Error("Refusing to publish message with no recipients");
        }
      }

      const parentHasFork = parentFork != null;

      message.root = parentHasFork ? parentKey : parentRoot;
      message.branch = await post.branch({ root: parent.key });
      message.type = "post"; // redundant but used for validation

      if (isComment(message) !== true) {
        const messageString = JSON.stringify(message, null, 2);
        throw new Error(`message should be valid comment: ${messageString}`);
      }

      return post.publish(message);
    },
    branch: async ({ root }) => {
      const ssb = await cooler.open();
      const keys = await ssb.tangle.branch(root);

      return keys;
    },
    inbox: async (customOptions = {}) => {
      const ssb = await cooler.open();

      const myFeedId = ssb.id;

      const options = configure(
        {
          query: [{ $filter: { dest: ssb.id } }],
        },
        customOptions
      );

      const source = ssb.backlinks.read(options);

      const messages = await new Promise((resolve, reject) => {
        pull(
          source,
          // Make sure we're only getting private messages that are posts.
          pull.filter(
            (message) =>
              isDecrypted(message) &&
              lodash.get(message, "value.content.type") === "post"
          ),
          pull.unique((message) => {
            const { root } = message.value.content;
            if (root == null) {
              return message.key;
            } else {
              return root;
            }
          }),
          pull.take(maxMessages),
          pull.collect((err, collectedMessages) => {
            if (err) {
              reject(err);
            } else {
              resolve(transform(ssb, collectedMessages, myFeedId));
            }
          })
        );
      });

      return messages;
    },
  };
  models.post = post;

  models.vote = {
    /** @param {{messageKey: string, value: {}, recps: []}} input */
    publish: async ({ messageKey, value, recps }) => {
      const ssb = await cooler.open();
      const branch = await ssb.tangle.branch(messageKey);

      await ssb.publish({
        type: "vote",
        vote: {
          link: messageKey,
          value: Number(value),
        },
        branch,
        recps,
      });
    },
  };

  return models;
};
