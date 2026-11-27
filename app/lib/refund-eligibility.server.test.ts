import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { getRefundEligibility } from "./refund-eligibility.server";

// Noon, so the calendar-day arithmetic cannot slip across midnight.
const PURCHASED_AT = new Date(2026, 0, 10, 12, 0, 0);

function daysAfterPurchase(days: number, hour = 12) {
  const when = new Date(PURCHASED_AT);
  when.setDate(when.getDate() + days);
  when.setHours(hour);
  return when;
}

let base: ReturnType<typeof seedBaseData>;
let lessonIds: number[];

function buy(amountPaid: number, country: string | null = "US") {
  return testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid,
      country,
      createdAt: PURCHASED_AT.toISOString(),
    })
    .returning()
    .get();
}

function completeLessons(count: number) {
  for (const lessonId of lessonIds.slice(0, count)) {
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId: base.user.id,
        lessonId,
        status: schema.LessonProgressStatus.Completed,
      })
      .run();
  }
}

function watch(lessonId: number, positionSeconds: number) {
  testDb
    .insert(schema.videoWatchEvents)
    .values({
      userId: base.user.id,
      lessonId,
      eventType: "progress",
      positionSeconds,
    })
    .run();
}

function eligibility(now = daysAfterPurchase(1)) {
  return getRefundEligibility(base.user.id, base.course.id, now);
}

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);

  const module = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module 1", position: 1 })
    .returning()
    .get();

  lessonIds = [1, 2, 3, 4].map(
    (position) =>
      testDb
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

describe("getRefundEligibility", () => {
  it("offers nothing to someone who has not bought the course", () => {
    expect(eligibility()).toEqual({ status: "none" });
  });

  it("offers back exactly what was paid, whatever the list price", () => {
    // The $100-paid, $200-emailed support ticket: the amount must come from
    // the purchase, never from the course's current price.
    const purchase = buy(10000);
    testDb
      .update(schema.courses)
      .set({ price: 20000 })
      .run();

    expect(eligibility()).toEqual({
      status: "eligible",
      purchaseId: purchase.id,
      amount: 10000,
    });
  });

  it("stays eligible on the last day of the 14-day window", () => {
    buy(10000);
    expect(eligibility(daysAfterPurchase(14, 23)).status).toBe("eligible");
  });

  it("explains that the window has closed on the 15th day", () => {
    buy(10000);
    expect(eligibility(daysAfterPurchase(15, 0))).toEqual({
      status: "ineligible",
      reasons: ["The 14-day refund window ended on January 24, 2026."],
    });
  });

  it("explains that too much of the course has been watched", () => {
    buy(10000);
    watch(lessonIds[0], 60 * 60);
    watch(lessonIds[1], 60 * 60);

    expect(eligibility()).toEqual({
      status: "ineligible",
      reasons: ["You've watched more than 2 hours of this course."],
    });
  });

  it("counts only the furthest point reached in each lesson", () => {
    buy(10000);
    watch(lessonIds[0], 60 * 60);
    watch(lessonIds[0], 90 * 60);

    expect(eligibility().status).toBe("eligible");
  });

  it("explains that half or more of the lessons are complete", () => {
    buy(10000);
    completeLessons(2);

    expect(eligibility()).toEqual({
      status: "ineligible",
      reasons: ["You've completed half or more of the lessons."],
    });
  });

  it("stays eligible below half of the lessons complete", () => {
    buy(10000);
    completeLessons(1);
    expect(eligibility().status).toBe("eligible");
  });

  it("explains that a team seat from the purchase has been claimed", () => {
    const purchase = buy(50000);
    const team = testDb
      .insert(schema.teams)
      .values({})
      .returning()
      .get();
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: "SEAT-1",
        purchaseId: purchase.id,
        redeemedByUserId: base.instructor.id,
        redeemedAt: PURCHASED_AT.toISOString(),
      })
      .run();

    expect(eligibility()).toEqual({
      status: "ineligible",
      reasons: ["A team seat from this purchase has been claimed."],
    });
  });

  it("lists every reason that applies", () => {
    buy(10000);
    completeLessons(4);
    watch(lessonIds[0], 3 * 60 * 60);

    expect(eligibility(daysAfterPurchase(30))).toEqual({
      status: "ineligible",
      reasons: [
        "The 14-day refund window ended on January 24, 2026.",
        "You've watched more than 2 hours of this course.",
        "You've completed half or more of the lessons.",
      ],
    });
  });

  it("reports a pending refund request instead of offering another", () => {
    const purchase = buy(10000);
    testDb
      .insert(schema.refundRequests)
      .values({
        purchaseId: purchase.id,
        reason: "Not what I expected.",
        requestedAt: "2026-01-11T09:00:00.000Z",
      })
      .run();

    expect(eligibility()).toEqual({
      status: "pending",
      requestedAt: "2026-01-11T09:00:00.000Z",
    });
  });

  it("allows a new request after an earlier one was declined", () => {
    const purchase = buy(10000);
    testDb
      .insert(schema.refundRequests)
      .values({
        purchaseId: purchase.id,
        reason: "Not what I expected.",
        status: schema.RefundRequestStatus.Declined,
      })
      .run();

    expect(eligibility().status).toBe("eligible");
  });
});
