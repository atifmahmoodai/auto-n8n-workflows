import { fireEvent, render, screen } from "@testing-library/react-native";
import HomeScreen from "../index";
import ReviewScreen from "../review";
import SignInScreen from "../sign-in";

jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({ uri: "file:///cache/photo.jpg", width: "3000", height: "4000" }),
  useNavigation: () => ({ addListener: () => () => {}, dispatch: jest.fn() }),
}));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
jest.mock("../../lib/auth", () => ({
  useAuth: () => ({ user: { givenName: "Atif", name: "Atif M", photo: null, email: "a@b.c" }, signIn: jest.fn() }),
  isCancellation: () => false,
  AuthError: class extends Error {},
}));
jest.mock("../../lib/useReceipts", () => ({
  useReceiptList: () => ({
    receipts: [
      {
        id: "r1",
        merchant: "Fresh Market",
        purchaseDate: new Date().toISOString().slice(0, 10),
        currency: "USD",
        subtotal: 10,
        tax: 0.8,
        total: 10.8,
        paymentMethod: null,
        notes: null,
        imageUri: null,
        createdAt: new Date().toISOString(),
        syncStatus: "synced",
        syncError: null,
        itemCount: 3,
      },
    ],
    error: null,
    reload: jest.fn(),
  }),
}));
jest.mock("../../lib/sync", () => ({ syncAllPending: jest.fn() }));
jest.mock("../../lib/image", () => ({
  prepareReceiptImage: jest.fn(async () => ({ uri: "file:///cache/small.jpg", base64: "AAAA" })),
}));
jest.mock("../../lib/receipts", () => ({
  ...jest.requireActual("../../lib/receipts"),
  saveDraft: jest.fn(async () => "new-id"),
}));
jest.mock("../../lib/api", () => ({
  parseReceiptImage: jest.fn(async () => ({
    is_receipt: true,
    merchant: "Fresh Market",
    purchase_date: "2026-09-28",
    currency: "USD",
    items: [
      { name: "Bananas", quantity: 1.2, unit_price: 0.59, total_price: 0.71, category: "produce" },
      { name: "Whole Milk", quantity: 1, unit_price: 3.49, total_price: 3.49, category: "dairy" },
    ],
    subtotal: 4.2,
    tax: 0,
    total: 4.2,
    payment_method: "Visa ****1234",
    notes: null,
  })),
}));
jest.mock("expo-crypto", () => {
  let n = 0;
  return { randomUUID: () => `id-${++n}` };
});

it("renders the sign-in screen", async () => {
  await render(<SignInScreen />);
  expect(screen.getByText("Continue with Google")).toBeTruthy();
});

it("renders the home dashboard with receipts and this month's total", async () => {
  await render(<HomeScreen />);
  expect(screen.getByText("Fresh Market")).toBeTruthy();
  expect(screen.getAllByText("$10.80").length).toBeGreaterThan(0);
  expect(screen.getByText("Scan receipt")).toBeTruthy();
});

it("shows every extracted item and price right after scanning, and saves", async () => {
  await render(<ReviewScreen />);

  expect(await screen.findByText("Bananas")).toBeTruthy();
  expect(screen.getByText("Whole Milk")).toBeTruthy();
  expect(screen.getByText("$0.71")).toBeTruthy();
  expect(screen.getByText("$3.49")).toBeTruthy();
  expect(screen.getByText("2 items")).toBeTruthy();

  const { saveDraft } = jest.requireMock("../../lib/receipts");
  const { router } = jest.requireMock("expo-router");
  await fireEvent.press(screen.getByText("Save & add to Google Sheets"));
  expect(saveDraft).toHaveBeenCalledWith(expect.objectContaining({ merchant: "Fresh Market" }), "file:///cache/small.jpg");
  expect(router.replace).toHaveBeenCalledWith({ pathname: "/receipt/[id]", params: { id: "new-id" } });
});
