/* =====================================================================
   ShopEarn — app.js
   Full frontend logic wired to Firebase (Auth + Firestore) and Stripe.

   FIRESTORE DATA MODEL
   ---------------------------------------------------------------------
   users/{uid}
     name, email, photoURL, createdAt
     inviteCode          : string  (this user's own code, shareable)
     referredBy          : string  (the invite code they signed up with, or null)
     l1InviterUid         : string  (uid of direct inviter, or null)
     l2InviterUid         : string  (uid of inviter's inviter, or null)
     walletBalance        : number  (spendable earnings)
     totalEarned           : number
     totalSpent            : number
     activeMonthKey        : string  ("2026-06") -> last month user purchased in
     wishlist              : array of productIds
     addresses             : array of address objects

   products/{productId}
     name, description, price, image, category, stock
     l1SharePct   : number (e.g. 10 -> 10%)
     l2SharePct   : number (e.g. 5  -> 5%)

   orders/{orderId}
     buyerUid, items[], subtotal, shipping, total, walletUsed
     paymentMethod, status, createdAt
     commissionsPaid: [{ uid, level, amount, productId }]

   transactions/{txId}
     uid, type ("credit"/"debit"), amount, reason, createdAt, relatedOrderId

   notifications/{notifId}
     uid, title, body, read, createdAt

   invites/{code}  -> maps an invite code straight to a uid (fast lookup)
===================================================================== */

/* ---------------------------------------------------------------------
   GLOBAL STATE
--------------------------------------------------------------------- */
let currentUser = null;       // Firebase auth user
let userData = null;          // Firestore users/{uid} document data
let allProducts = [];         // cached product catalog
let filteredProducts = [];    // after search/filter/sort
let cart = [];                // [{ productId, qty }]
let categories = [];
let activeFilterCategory = null;
let countdownInterval = null;

const SHIPPING_FLAT_FEE = 250; // ₨ flat shipping, adjust as needed
const ACTIVATION_FEE = 100; // ₨ monthly activation fee

/* ---------------------------------------------------------------------
   INIT
--------------------------------------------------------------------- */
document.addEventListener("DOMContentLoaded", () => {

  setupAuthListener();
  startFlashSaleCountdown();
});



function setupAuthListener() {
  auth.onAuthStateChanged(async (user) => {
    showSpinner(true);
    if (user) {
      currentUser = user;
      await loadUserData(user.uid);
      await checkAndExpireInactiveCodes(); // monthly renewal check
      document.getElementById("authOverlay").classList.remove("active");
      document.getElementById("appShell").classList.remove("hidden");
      await bootstrapApp();
      const savedPage = sessionStorage.getItem("currentPage");
      if (savedPage && savedPage !== "home") showPage(savedPage);
    } else {
      currentUser = null;
      userData = null;
      document.getElementById("authOverlay").classList.add("active");
      document.getElementById("appShell").classList.add("hidden");
    }
    showSpinner(false);
  });
}

async function bootstrapApp() {
  updateHeaderForSidebar();
  await Promise.all([loadProducts(), loadCategories()]);
  renderHomeStats();
  renderCategoriesScroll();
  renderHomeProducts();
  renderProfile();
  await loadCart();
  await loadWishlistBadge();
  await loadNotificationsBadge();
  renderInviteCode();
}

/* =====================================================================
   AUTHENTICATION
===================================================================== */
function switchAuthTab(tab) {
  document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".auth-form").forEach((f) => f.classList.remove("active"));
  if (tab === "login") {
    document.querySelectorAll(".auth-tab")[0].classList.add("active");
    document.getElementById("loginForm").classList.add("active");
  } else {
    document.querySelectorAll(".auth-tab")[1].classList.add("active");
    document.getElementById("registerForm").classList.add("active");
  }
}

function togglePw(id) {
  const input = document.getElementById(id);
  input.type = input.type === "password" ? "text" : "password";
}

async function loginUser() {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  if (!email || !password) return showToast("Please fill in all fields", "error");

  showSpinner(true);
  try {
    await auth.signInWithEmailAndPassword(email, password);
    showToast("Welcome back!", "success");
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    showSpinner(false);
  }
}

async function loginWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  showSpinner(true);
  try {
    const result = await auth.signInWithPopup(provider);
    const docSnap = await db.collection("users").doc(result.user.uid).get();
    if (!docSnap.exists) {
      // First time Google sign-in -> create profile (no referral code possible via this flow)
      await createUserProfile(result.user.uid, {
        name: result.user.displayName || "User",
        email: result.user.email,
        photoURL: result.user.photoURL || "",
        referralCodeUsed: null,
      });
    }
    showToast("Welcome!", "success");
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    showSpinner(false);
  }
}

async function registerUser() {
  const name = document.getElementById("regName").value.trim();
  const email = document.getElementById("regEmail").value.trim();
  const password = document.getElementById("regPassword").value;
  const referralCodeUsed = null;

  if (!name || !email || !password) return showToast("Please fill in all required fields", "error");
  if (password.length < 6) return showToast("Password must be at least 6 characters", "error");

  showSpinner(true);
  try {
    // Validate referral code BEFORE creating the account, so we don't orphan a user
    let inviterUid = null;
    if (referralCodeUsed) {
      const inviteDoc = await db.collection("invites").doc(referralCodeUsed).get();
      if (!inviteDoc.exists) {
        showSpinner(false);
        return showToast("Invalid referral code", "error");
      }
      inviterUid = inviteDoc.data().uid;
    }

    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await createUserProfile(cred.user.uid, {
      name,
      email,
      photoURL: "",
      referralCodeUsed: referralCodeUsed || null,
      inviterUid,
    });
    showToast("Account created! Welcome to ShopEarn 🎉", "success");
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    showSpinner(false);
  }
}

/**
 * Creates the Firestore user document, generates this user's own invite code,
 * and links them into the referral chain (L1 = direct inviter, L2 = inviter's inviter).
 */
async function createUserProfile(uid, { name, email, photoURL, referralCodeUsed, inviterUid }) {
  const myInviteCode = generateInviteCode();

  let l1InviterUid = null;
  let l2InviterUid = null;

  if (inviterUid) {
    l1InviterUid = inviterUid;
    // climb one more level: find who invited my inviter
    const inviterDoc = await db.collection("users").doc(inviterUid).get();
    if (inviterDoc.exists) {
      l2InviterUid = inviterDoc.data().l1InviterUid || null;
    }
  }

  const newUser = {
    name,
    email,
    photoURL,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    inviteCode: myInviteCode,
    referredBy: referralCodeUsed || null,
    l1InviterUid,
    l2InviterUid,
    walletBalance: 0,
    totalEarned: 0,
    totalSpent: 0,
    activeMonthKey: null, // not active until first purchase
    wishlist: [],
    addresses: [],
  };

  await db.collection("users").doc(uid).set(newUser);
  await db.collection("invites").doc(myInviteCode).set({ uid });

  if (inviterUid) {
    await notifyUser(inviterUid, "New referral!", `${name} just joined using your invite code.`);
  }
}

function generateInviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let code = "";
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function logoutUser() {
  await auth.signOut();
  showToast("Logged out", "success");
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebarOverlay").classList.remove("active");
}

/* =====================================================================
   LOAD USER DATA
===================================================================== */
async function loadUserData(uid) {
  const doc = await db.collection("users").doc(uid).get();
  if (doc.exists) {
    userData = { uid, ...doc.data() };
  }
}

async function refreshUserData() {
  if (currentUser) await loadUserData(currentUser.uid);
}

/* =====================================================================
   MONTHLY CODE ACTIVITY / RENEWAL LOGIC
   ---------------------------------------------------------------------
   "Active" means the user purchased at least once during the CURRENT
   calendar month. activeMonthKey stores "YYYY-MM" of their last purchase.
   If activeMonthKey !== current month key, the user's code is inactive
   and they earn ZERO commission from their downline until they buy
   something again themselves.
===================================================================== */
function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function isUserActiveThisMonth(userDoc) {
  return userDoc && userDoc.activeMonthKey === currentMonthKey();
}

/**
 * Called once per session on login — purely informational refresh,
 * no writes needed since "active" is just a derived comparison against
 * activeMonthKey. Kept as a hook in case you want to push a notification
 * reminding inactive users to renew.
 */
async function checkAndExpireInactiveCodes() {
  if (!userData) return;
  // Only show warning if user has been active before but not this month
  if (userData.activeMonthKey && !isUserActiveThisMonth(userData)) {
    showToast("Your referral code is inactive this month. Buy something to start earning again!", "error");
  }
}

/**
 * Marks a user active for the current month. Called every time they
 * complete a purchase (as buyer).
 */
async function markUserActiveThisMonth(uid) {
  await db.collection("users").doc(uid).update({ activeMonthKey: currentMonthKey() });
}

/* =====================================================================
   PRODUCTS
===================================================================== */
async function loadProducts() {
  const snap = await db.collection("products").get();
  allProducts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  filteredProducts = [...allProducts];
}

async function loadCategories() {
  const set = new Set(allProducts.map((p) => p.category).filter(Boolean));
  categories = [...set];
}

function renderCategoriesScroll() {
  const el = document.getElementById("categoriesScroll");
  if (!el) return;
  el.innerHTML = categories
    .map(
      (c) => `
      <div class="category-chip" onclick="filterByCategory('${escapeHtml(c)}')">
        <span class="material-icons-round">category</span>
        <span>${escapeHtml(c)}</span>
      </div>`
    )
    .join("");
}

function renderCategoriesGrid() {
  const el = document.getElementById("categoriesGrid");
  if (!el) return;

  if (!categories.length) {
    el.innerHTML = emptyState("category", "No categories yet", "Products will appear here once added.");
    return;
  }

  el.innerHTML = categories.map(cat => {
    const catProducts = allProducts.filter(p => p.category === cat);
    return `
      <div class="cat-section">
        <div class="cat-section-header">
          <div class="cat-section-title">
            <span class="material-icons-round">category</span>
            <h3>${escapeHtml(cat)}</h3>
            <span class="cat-count">${catProducts.length} item${catProducts.length !== 1 ? 's' : ''}</span>
          </div>
          <button class="see-all" onclick="filterByCategory('${escapeHtml(cat)}')">See all</button>
        </div>
        <div class="product-grid">
          ${catProducts.length
            ? catProducts.slice(0, 4).map(productCardHTML).join("")
            : `<p style="color:var(--text-muted);font-size:13px;padding:12px 0">No products in this category.</p>`
          }
        </div>
      </div>`;
  }).join("");
}

function filterByCategory(cat) {
  activeFilterCategory = cat;
  filteredProducts = allProducts.filter((p) => p.category === cat);
  showPage("shop");
  renderShopProducts();
}

function productCardHTML(p) {
  const inWishlist = userData?.wishlist?.includes(p.id);
  const badge = p.isFlashSale
    ? `<span class="commission-tag" style="background:#ef4444">${p.discountPct}% OFF</span>`
    : p.l1SharePct
    ? `<span class="commission-tag">Earn ${p.l1SharePct}%</span>`
    : "";

  const priceHTML = p.isFlashSale && p.originalPrice
    ? `<p class="product-price">₨ ${formatMoney(p.price)} <del style="font-size:11px;color:#94a3b8;font-weight:400">₨ ${formatMoney(p.originalPrice)}</del></p>`
    : `<p class="product-price">₨ ${formatMoney(p.price)}</p>`;

  return `
    <div class="product-card">
      <div class="product-img-wrap" onclick="openProduct('${p.id}')">
        <img src="${p.image || placeholderImg()}" alt="${escapeHtml(p.name)}" loading="lazy" />
        ${badge}
      </div>
      <button class="wishlist-btn ${inWishlist ? "active" : ""}" onclick="toggleWishlist('${p.id}')">
        <span class="material-icons-round">${inWishlist ? "favorite" : "favorite_border"}</span>
      </button>
      <div class="product-info" onclick="openProduct('${p.id}')">
        <h4>${escapeHtml(p.name)}</h4>
        ${priceHTML}
      </div>
      <button class="btn-add-cart" onclick="addToCart('${p.id}')">
        <span class="material-icons-round">add_shopping_cart</span>
      </button>
    </div>`;
}

// FIX 1: Removed the orphaned duplicate code block that was here between
// renderHomeProducts and renderShopProducts, which caused "Illegal return statement".
function renderHomeProducts() {
  const el = document.getElementById("homeProductGrid");
  if (!el) return;
  el.innerHTML = Array(4).fill(`
    <div class="skeleton-card">
      <div class="skeleton skeleton-img"></div>
      <div class="skeleton skeleton-text"></div>
      <div class="skeleton skeleton-text-sm"></div>
    </div>`).join("");
  setTimeout(() => {
    const trending = allProducts.filter(p => !p.isFlashSale).slice(0, 8);
    el.innerHTML = trending.length
      ? trending.map(productCardHTML).join("")
      : emptyState("storefront", "No products yet", "Check back soon for new arrivals.");
  }, 300);
}

function renderShopProducts() {
  const el = document.getElementById("shopProductGrid");
  if (!el) return;
  el.innerHTML = filteredProducts.length
    ? filteredProducts.map(productCardHTML).join("")
    : emptyState("search_off", "No products found", "Try adjusting your filters.");
  renderFilterChips();
}

function renderFilterChips() {
  const el = document.getElementById("filterCategories");
  if (!el) return;
  el.innerHTML = categories
    .map(
      (c) => `
      <button class="filter-chip ${activeFilterCategory === c ? "active" : ""}" onclick="toggleCategoryChip('${escapeHtml(c)}')">
        ${escapeHtml(c)}
      </button>`
    )
    .join("");
}

function toggleCategoryChip(cat) {
  activeFilterCategory = activeFilterCategory === cat ? null : cat;
  renderFilterChips();
}

function toggleFilter() {
  document.getElementById("filterPanel").classList.toggle("hidden");
}

function applyFilters() {
  const min = parseFloat(document.getElementById("priceMin").value) || 0;
  const max = parseFloat(document.getElementById("priceMax").value) || Infinity;
  filteredProducts = allProducts.filter((p) => {
    const inCat = activeFilterCategory ? p.category === activeFilterCategory : true;
    const inPrice = p.price >= min && p.price <= max;
    return inCat && inPrice;
  });
  renderShopProducts();
  toggleFilter();
}

function clearFilters() {
  activeFilterCategory = null;
  document.getElementById("priceMin").value = "";
  document.getElementById("priceMax").value = "";
  filteredProducts = [...allProducts];
  renderShopProducts();
}

function sortProducts(mode) {
  const list = [...filteredProducts];
  if (mode === "price-asc") list.sort((a, b) => a.price - b.price);
  else if (mode === "price-desc") list.sort((a, b) => b.price - a.price);
  else if (mode === "name-asc") list.sort((a, b) => a.name.localeCompare(b.name));
  filteredProducts = list;
  renderShopProducts();
}

/* =====================================================================
   SEARCH
===================================================================== */
let searchDebounce = null;
function handleSearch(value) {
  document.getElementById("clearSearchBtn").style.display = value ? "inline-flex" : "none";
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    if (!value.trim()) return;
    const term = value.trim().toLowerCase();
    const results = allProducts.filter(
      (p) =>
        p.name.toLowerCase().includes(term) ||
        (p.category && p.category.toLowerCase().includes(term)) ||
        (p.description && p.description.toLowerCase().includes(term))
    );
    renderSearchResults(results, value);
    showPage("search");
  }, 300);
}

function renderSearchResults(results, term) {
  document.getElementById("searchResultCount").textContent = `${results.length} results for "${term}"`;
  const el = document.getElementById("searchResultsGrid");
  el.innerHTML = results.length
    ? results.map(productCardHTML).join("")
    : emptyState("search_off", "No matches found", "Try a different search term.");
}

function clearSearch() {
  document.getElementById("searchInput").value = "";
  document.getElementById("clearSearchBtn").style.display = "none";
}

/* =====================================================================
   PRODUCT DETAIL
===================================================================== */
function openProduct(id) {
  const p = allProducts.find((x) => x.id === id);
  if (!p) return;
  const inWishlist = userData?.wishlist?.includes(p.id);
  document.getElementById("productDetail").innerHTML = `
    <div class="product-detail-grid">
      <div class="product-detail-img">
        <img src="${p.image || placeholderImg()}" alt="${escapeHtml(p.name)}" />
      </div>
      <div class="product-detail-info">
        <span class="product-detail-cat">${escapeHtml(p.category || "")}</span>
        <h1>${escapeHtml(p.name)}</h1>
        <p class="product-detail-price">₨ ${formatMoney(p.price)}</p>
        ${
          p.l1SharePct
            ? `<div class="commission-box">
                <span class="material-icons-round">paid</span>
                <div>
                  <strong>Referral earnings on this item</strong>
                  <p>Level 1 inviter earns ${p.l1SharePct}% · Level 2 inviter earns ${p.l2SharePct || 0}%</p>
                </div>
              </div>`
            : ""
        }
        <p class="product-detail-desc">${escapeHtml(p.description || "No description available.")}</p>
        <p class="stock-info ${p.stock > 0 ? "in-stock" : "out-stock"}">
          ${p.stock > 0 ? `${p.stock} in stock` : "Out of stock"}
        </p>
        <div class="product-detail-actions">
          <button class="btn-primary" onclick="addToCart('${p.id}')" ${p.stock <= 0 ? "disabled" : ""}>
            <span class="material-icons-round">add_shopping_cart</span> Add to Cart
          </button>
          <button class="btn-outline" onclick="toggleWishlist('${p.id}')">
            <span class="material-icons-round">${inWishlist ? "favorite" : "favorite_border"}</span>
          </button>
        </div>
      </div>
    </div>`;
  showPage("product");
}

/* =====================================================================
   CART
===================================================================== */
async function loadCart() {
  try {
    const doc = await db.collection("carts").doc(currentUser.uid).get();
    cart = doc.exists ? doc.data().items || [] : [];
  } catch {
    cart = [];
  }
  updateCartBadge();
}

async function saveCart() {
  await db.collection("carts").doc(currentUser.uid).set({ items: cart });
}

async function addToCart(productId) {
  const existing = cart.find((i) => i.productId === productId);
  if (existing) existing.qty += 1;
  else cart.push({ productId, qty: 1 });
  await saveCart();
  updateCartBadge();
  showToast("Added to cart", "success");
}

async function updateCartQty(productId, qty) {
  if (qty <= 0) return removeFromCart(productId);
  const item = cart.find((i) => i.productId === productId);
  if (item) item.qty = qty;
  await saveCart();
  renderCart();
}

async function removeFromCart(productId) {
  cart = cart.filter((i) => i.productId !== productId);
  await saveCart();
  renderCart();
  updateCartBadge();
}

function updateCartBadge() {
  const badge = document.getElementById("cartBadge");
  const count = cart.reduce((sum, i) => sum + i.qty, 0);
  badge.textContent = count;
  badge.style.display = count > 0 ? "inline-flex" : "none";
}

function getCartLineItems() {
  return cart
    .map((i) => {
      const product = allProducts.find((p) => p.id === i.productId);
      return product ? { ...product, qty: i.qty } : null;
    })
    .filter(Boolean);
}

function renderCart() {
  const items = getCartLineItems();
  const el = document.getElementById("cartItems");

  el.innerHTML = items.length
    ? items
        .map(
          (item) => `
      <div class="cart-item">
        <img src="${item.image || placeholderImg()}" alt="${escapeHtml(item.name)}" />
        <div class="cart-item-info">
          <h4>${escapeHtml(item.name)}</h4>
          <p>₨ ${formatMoney(item.price)}</p>
        </div>
        <div class="qty-control">
          <button onclick="updateCartQty('${item.id}', ${item.qty - 1})">−</button>
          <span>${item.qty}</span>
          <button onclick="updateCartQty('${item.id}', ${item.qty + 1})">+</button>
        </div>
        <button class="icon-btn" onclick="removeFromCart('${item.id}')">
          <span class="material-icons-round">delete_outline</span>
        </button>
      </div>`
        )
        .join("")
    : `<div class="empty-state">
    <span class="material-icons-round">shopping_cart</span>
    <h3>Your cart is empty</h3>
    <p>Add some products to get started.</p>
    <button class="btn-primary" style="margin-top:16px" onclick="showPage('shop')">
      <span class="material-icons-round">storefront</span> Shop Now
    </button>
  </div>`;

  renderCartSummary(items);
}

function renderCartSummary(items) {
  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const shipping = items.length ? SHIPPING_FLAT_FEE : 0;
  const walletBalance = userData?.walletBalance || 0;
  const useWallet = document.getElementById("useWalletCheck")?.checked;
  const walletDiscount = useWallet ? Math.min(walletBalance, subtotal + shipping) : 0;
  const total = Math.max(0, subtotal + shipping - walletDiscount);

  document.getElementById("cartSubtotal").textContent = `₨ ${formatMoney(subtotal)}`;
  document.getElementById("cartShipping").textContent = `₨ ${formatMoney(shipping)}`;
  document.getElementById("cartDiscount").textContent = `– ₨ ${formatMoney(walletDiscount)}`;
  document.getElementById("cartTotal").textContent = `₨ ${formatMoney(total)}`;
  document.getElementById("walletAvailable").textContent = `(₨ ${formatMoney(walletBalance)} available)`;
}

function toggleWalletUse() {
  renderCart();
}

function proceedToCheckout() {
  if (!cart.length) return showToast("Your cart is empty", "error");
  showPage("checkout");
  renderCheckout();
}

/* =====================================================================
   WISHLIST
===================================================================== */
async function toggleWishlist(productId) {
  const list = userData.wishlist || [];
  const idx = list.indexOf(productId);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(productId);

  await db.collection("users").doc(currentUser.uid).update({ wishlist: list });
  userData.wishlist = list;
  loadWishlistBadge();

  if (document.getElementById("shopPage").classList.contains("active")) renderShopProducts();
  if (document.getElementById("homePage").classList.contains("active")) renderHomeProducts();
  if (document.getElementById("wishlistPage").classList.contains("active")) renderWishlist();

  showToast(idx >= 0 ? "Removed from wishlist" : "Added to wishlist", "success");
}

function loadWishlistBadge() {
  const badge = document.getElementById("wishlistBadge");
  const count = userData?.wishlist?.length || 0;
  badge.textContent = count;
  badge.style.display = count > 0 ? "inline-flex" : "none";
}

function renderWishlist() {
  const ids = userData?.wishlist || [];
  const items = allProducts.filter((p) => ids.includes(p.id));
  document.getElementById("wishlistGrid").innerHTML = items.length
    ? items.map(productCardHTML).join("")
    : emptyState("favorite_border", "Your wishlist is empty", "Tap the heart on any product to save it here.");
}

/* =====================================================================
   CHECKOUT + PAYMENT + COMMISSION ENGINE (the core of the spec)
===================================================================== */
function renderCheckout() {
  const items = getCartLineItems();
  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const shipping = SHIPPING_FLAT_FEE;
  const total = subtotal + shipping;

  document.getElementById("checkoutItems").innerHTML = items
    .map(
      (i) => `<div class="checkout-line"><span>${escapeHtml(i.name)} × ${i.qty}</span><span>₨ ${formatMoney(i.price * i.qty)}</span></div>`
    )
    .join("");
  document.getElementById("coSubtotal").textContent = `₨ ${formatMoney(subtotal)}`;
  document.getElementById("coShipping").textContent = `₨ ${formatMoney(shipping)}`;
  document.getElementById("coTotal").textContent = `₨ ${formatMoney(total)}`;

// Pre-fill saved address if available
  const addr = userData?.addresses?.[0];
  if (addr) {
    document.getElementById("coName").value = addr.name || "";
    document.getElementById("coPhone").value = addr.phone || "";
    document.getElementById("coAddress").value = addr.address || "";
    document.getElementById("coCity").value = addr.city || "";
    document.getElementById("coPostal").value = addr.postal || "";
  }
}

const PAYMENT_ACCOUNTS = {
  jazzcash:  { number: "03368733364", name: "Hafiz Abdullah Dawood" },
  easypaisa: { number: "0336873364", name: "Hafiz Abdullah Dawood" },
  bank:      { bankName: "HBL", accountNo: "1234567890", accountTitle: "Muhammad Ali", iban: "PK36HABB0000001123456702" },
};
function switchPayment(method) {
  const box = document.getElementById("paymentDetails");
  if (method === "cod" || method === "wallet") {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }
  box.style.display = "block";
  if (method === "jazzcash") {
    box.innerHTML = `
      <div style="text-align:center;padding:8px 0">
        <img src="https://upload.wikimedia.org/wikipedia/en/e/e9/JazzCash.png"
          style="height:36px;margin:0 auto 12px;display:block;object-fit:contain"
          onerror="this.style.display='none'" />
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:10px">
          Send payment to this JazzCash number:
        </p>
        <div style="background:var(--primary-50);border-radius:10px;padding:12px;margin-bottom:12px">
          <strong style="font-size:18px;color:var(--primary-dark);letter-spacing:1px">
            ${PAYMENT_ACCOUNTS.jazzcash.number}
          </strong>
          <p style="font-size:12px;color:var(--text-muted);margin-top:4px">
            ${PAYMENT_ACCOUNTS.jazzcash.name}
          </p>
        </div>
        <div class="input-group" style="margin-top:8px">
          <span class="material-icons-round">tag</span>
          <input type="text" id="txnId" placeholder="Enter JazzCash Transaction ID" />
        </div>
      </div>`;
  } else if (method === "easypaisa") {
    box.innerHTML = `
      <div style="text-align:center;padding:8px 0">
        <img src="https://upload.wikimedia.org/wikipedia/en/8/85/Easypaisa_logo.png"
          style="height:36px;margin:0 auto 12px;display:block;object-fit:contain"
          onerror="this.style.display='none'" />
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:10px">
          Send payment to this EasyPaisa number:
        </p>
        <div style="background:var(--primary-50);border-radius:10px;padding:12px;margin-bottom:12px">
          <strong style="font-size:18px;color:var(--primary-dark);letter-spacing:1px">
            ${PAYMENT_ACCOUNTS.easypaisa.number}
          </strong>
          <p style="font-size:12px;color:var(--text-muted);margin-top:4px">
            ${PAYMENT_ACCOUNTS.easypaisa.name}
          </p>
        </div>
        <div class="input-group" style="margin-top:8px">
          <span class="material-icons-round">tag</span>
          <input type="text" id="txnId" placeholder="Enter EasyPaisa Transaction ID" />
        </div>
      </div>`;
  } else if (method === "bank") {
    box.innerHTML = `
      <div style="padding:8px 0">
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">
          Transfer to this bank account:
        </p>
        <div style="background:var(--surface-alt);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:8px;margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;font-size:13px">
            <span style="color:var(--text-muted)">Bank</span>
            <strong>${PAYMENT_ACCOUNTS.bank.bankName}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:13px">
            <span style="color:var(--text-muted)">Account Title</span>
            <strong>${PAYMENT_ACCOUNTS.bank.accountTitle}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:13px">
            <span style="color:var(--text-muted)">Account No</span>
            <strong>${PAYMENT_ACCOUNTS.bank.accountNo}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:13px">
            <span style="color:var(--text-muted)">IBAN</span>
            <strong style="font-size:11px">${PAYMENT_ACCOUNTS.bank.iban}</strong>
          </div>
        </div>
        <div class="input-group">
          <span class="material-icons-round">tag</span>
          <input type="text" id="txnId" placeholder="Enter bank transaction reference" />
        </div>
      </div>`;
  }
}
// Stores validated referral data from checkout
let checkoutReferralData = null;

async function validateCheckoutReferral() {
  const code = document.getElementById("checkoutReferral").value.trim().toUpperCase();
  const statusEl = document.getElementById("referralApplyStatus");

  if (!code) {
    statusEl.style.display = "none";
    checkoutReferralData = null;
    return;
  }

  // Cannot use your own code
  if (code === userData.inviteCode) {
    statusEl.style.display = "block";
    statusEl.style.color = "var(--danger)";
    statusEl.innerHTML = `<span class="material-icons-round" style="font-size:15px;vertical-align:middle">cancel</span> You cannot use your own referral code`;
    checkoutReferralData = null;
    return;
  }

  showSpinner(true);
  try {
    const inviteDoc = await db.collection("invites").doc(code).get();
    if (!inviteDoc.exists) {
      statusEl.style.display = "block";
      statusEl.style.color = "var(--danger)";
      statusEl.innerHTML = `<span class="material-icons-round" style="font-size:15px;vertical-align:middle">cancel</span> Invalid referral code`;
      checkoutReferralData = null;
      return;
    }

    const inviterUid = inviteDoc.data().uid;
    const inviterDoc = await db.collection("users").doc(inviterUid).get();
    const inviter = inviterDoc.data();

    // Check if inviter is active this month
    if (!isUserActiveThisMonth(inviter)) {
      statusEl.style.display = "block";
      statusEl.style.color = "var(--warning)";
      statusEl.innerHTML = `<span class="material-icons-round" style="font-size:15px;vertical-align:middle">warning</span> This referral code is inactive this month`;
      checkoutReferralData = null;
      return;
    }

    checkoutReferralData = { uid: inviterUid, name: inviter.name, code };

    statusEl.style.display = "block";
    statusEl.style.color = "var(--success)";
    statusEl.innerHTML = `<span class="material-icons-round" style="font-size:15px;vertical-align:middle">check_circle</span> Code applied! <strong>${escapeHtml(inviter.name)}</strong> will earn commission on this order`;

  } catch (err) {
    statusEl.style.display = "block";
    statusEl.style.color = "var(--danger)";
    statusEl.innerHTML = `Error: ${err.message}`;
    checkoutReferralData = null;
  } finally {
    showSpinner(false);
  }
}





/**
 * MAIN CHECKOUT HANDLER
 * Implements spec points 5–12:
 *  - charges buyer the full total (card / wallet / COD)
 *  - on success, for EACH product line item independently:
 *      - looks up that product's l1SharePct / l2SharePct
 *      - checks if buyer's L1 inviter is active this month -> credit wallet
 *      - checks if buyer's L2 inviter is active this month -> credit wallet
 *      - inactive inviters get ZERO for that purchase (lost, not saved)
 *  - marks the BUYER active for this month (so their own downline can earn from them)
 *  - writes order, transactions, notifications
 */
async function placeOrder() {
  const name = document.getElementById("coName").value.trim();
  const phone = document.getElementById("coPhone").value.trim();
  const address = document.getElementById("coAddress").value.trim();
  const city = document.getElementById("coCity").value.trim();
  const postal = document.getElementById("coPostal").value.trim();

  if (!name || !phone || !address || !city) {
    return showToast("Please fill in all delivery details", "error");
  }

  // Phone number validation
  const phoneRegex = /^03[0-9]{9}$/;
  if (!phoneRegex.test(phone)) {
    return showToast("Please enter a valid Pakistani phone number (e.g. 03001234567)", "error");
  }
  const items = getCartLineItems();
  if (!items.length) return showToast("Your cart is empty", "error");

  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const shipping = SHIPPING_FLAT_FEE;
  const total = subtotal + shipping;
  const paymentMethod = document.querySelector('input[name="payMethod"]:checked').value;

  showSpinner(true);
  try {
    // ---- 1. Take payment ----
    if (paymentMethod === "jazzcash" || paymentMethod === "easypaisa" || paymentMethod === "bank") {
      const txnId = document.getElementById("txnId")?.value.trim();
      if (!txnId) {
        showSpinner(false);
        return showToast("Please enter your transaction ID", "error");
      }
    } else if (paymentMethod === "wallet") {
      if ((userData.walletBalance || 0) < total) {
        showSpinner(false);
        return showToast("Insufficient wallet balance", "error");
      }
    }
    // "cod" needs no upfront charge

    // ---- 2. Build commission breakdown per line item ----
    const commissionsPaid = [];
    let l1TotalCredit = 0;
    let l2TotalCredit = 0;

   // Use checkout referral code if provided, otherwise fall back to account's l1InviterUid

    const l1Uid = checkoutReferralData?.uid || userData?.l1InviterUid || null;

// Save inviter to buyer's account permanently if not already set
if (checkoutReferralData?.uid && !userData?.l1InviterUid) {
  await db.collection("users").doc(currentUser.uid).update({
    l1InviterUid: checkoutReferralData.uid,
    referredBy: checkoutReferralData.code,
  });
  userData.l1InviterUid = checkoutReferralData.uid;
}

// If checkout referral code was used, find that person's inviter as L2
let l2Uid = userData?.l2InviterUid || null;
if (checkoutReferralData?.uid) {
  const l1UserDoc = await db.collection("users").doc(checkoutReferralData.uid).get();
  if (l1UserDoc.exists) {
    l2Uid = l1UserDoc.data()?.l1InviterUid || null;
  }
}

    let l1Doc = null;
    let l2Doc = null;
    if (l1Uid) l1Doc = await db.collection("users").doc(l1Uid).get();
    if (l2Uid) l2Doc = await db.collection("users").doc(l2Uid).get();

    const l1Active = l1Doc && l1Doc.exists && isUserActiveThisMonth(l1Doc.data());
const l2Active = l2Doc && l2Doc.exists && isUserActiveThisMonth(l2Doc.data());


    for (const item of items) {
      const lineTotal = item.price * item.qty;
      const l1Pct = item.l1SharePct || 0;
      const l2Pct = item.l2SharePct || 0;

      

      if (l1Uid && l1Active && l1Pct > 0) {
        const amount = round2((lineTotal * l1Pct) / 100);
        l1TotalCredit += amount;
        commissionsPaid.push({ uid: l1Uid, level: 1, amount, productId: item.id });
      }
      if (l2Uid && l2Active && l2Pct > 0) {
        const amount = round2((lineTotal * l2Pct) / 100);
        l2TotalCredit += amount;
        commissionsPaid.push({ uid: l2Uid, level: 2, amount, productId: item.id });
      }
    }

    // ---- 3. Write the order ----
    const orderRef = db.collection("orders").doc();
    await orderRef.set({
      buyerUid: currentUser.uid,
      items: items.map((i) => ({ productId: i.id, name: i.name, price: i.price, qty: i.qty })),
      subtotal,
      shipping,
      total,
      walletUsed: paymentMethod === "wallet" ? total : 0,
      paymentMethod,
      status: paymentMethod === "cod" ? "pending" : "pending_verification",
      txnId: document.getElementById("txnId")?.value.trim() || null,
      address: { name, phone, address, city, postal },
      commissionsPaid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    // ---- 4. Settle buyer's wallet if they paid by wallet ----
    if (paymentMethod === "wallet") {
      await db.collection("users").doc(currentUser.uid).update({
        walletBalance: firebase.firestore.FieldValue.increment(-total),
        totalSpent: firebase.firestore.FieldValue.increment(total),
      });
      await logTransaction(currentUser.uid, "debit", total, "Order payment", orderRef.id);
    } else {
      await db.collection("users").doc(currentUser.uid).update({
        totalSpent: firebase.firestore.FieldValue.increment(total),
      });
    }

    // ---- 5. Mark buyer active this month (THIS purchase renews their own code) ----
    await markUserActiveThisMonth(currentUser.uid);

    
    // ---- 6. Credit commissions— only instantly for COD, wait for admin on online payments ----
    if (paymentMethod === "cod") {
      if (l1Uid && l1TotalCredit > 0) {
        await db.collection("users").doc(l1Uid).update({
          walletBalance: firebase.firestore.FieldValue.increment(l1TotalCredit),
          totalEarned: firebase.firestore.FieldValue.increment(l1TotalCredit),
        });
        await logTransaction(l1Uid, "credit", l1TotalCredit, `Level 1 commission from order`, orderRef.id);
        await notifyUser(l1Uid, "You earned a commission!", `You earned ₨ ${formatMoney(l1TotalCredit)} from a referral purchase.`);
      }
      if (l2Uid && l2TotalCredit > 0) {
        await db.collection("users").doc(l2Uid).update({
          walletBalance: firebase.firestore.FieldValue.increment(l2TotalCredit),
          totalEarned: firebase.firestore.FieldValue.increment(l2TotalCredit),
        });
        await logTransaction(l2Uid, "credit", l2TotalCredit, `Level 2 commission from order`, orderRef.id);
        await notifyUser(l2Uid, "You earned a commission!", `You earned ₨ ${formatMoney(l2TotalCredit)} from your network's purchase.`);
      }
    } else {
      // For JazzCash, EasyPaisa, Bank — notify inviters to wait for admin verification
      if (l1Uid && l1TotalCredit > 0) {
        await notifyUser(l1Uid, "Commission Pending!", `₨ ${formatMoney(l1TotalCredit)} commission is pending payment verification.`);
      }
      if (l2Uid && l2TotalCredit > 0) {
        await notifyUser(l2Uid, "Commission Pending!", `₨ ${formatMoney(l2TotalCredit)} commission is pending payment verification.`);
      }
    }
    

    // ---- 7. Reduce stock ----
    for (const item of items) {
      await db.collection("products").doc(item.id).update({
        stock: firebase.firestore.FieldValue.increment(-item.qty),
      });
    }

    // ---- 8. Clear cart, save address, refresh local state ----
    cart = [];
    checkoutReferralData = null;
    const refInput = document.getElementById("checkoutReferral");
    if (refInput) refInput.value = "";
    const refStatus = document.getElementById("referralApplyStatus");
    if (refStatus) refStatus.style.display = "none";
    await saveCart();
    await saveAddressIfNew({ name, phone, address, city, postal });
    await refreshUserData();
    await loadProducts();

    showToast("Order placed successfully! 🎉", "success");
    updateCartBadge();
    showPage("orders");
    renderOrders();
 } catch (err) {
  console.error(err);
  showToast("Error: " + err.message, "error");
  } finally {
    showSpinner(false);
  }
}

async function saveAddressIfNew(addr) {
  const list = userData.addresses || [];
  const exists = list.some((a) => a.address === addr.address && a.postal === addr.postal);
  if (!exists) {
    list.push(addr);
    await db.collection("users").doc(currentUser.uid).update({ addresses: list });
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/* =====================================================================
   TRANSACTIONS / WALLET
===================================================================== */
async function logTransaction(uid, type, amount, reason, relatedOrderId = null) {
  await db.collection("transactions").add({
    uid,
    type,
    amount,
    reason,
    relatedOrderId,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

async function loadTransactions() {
  const snap = await db
    .collection("transactions")
    .where("uid", "==", currentUser.uid)
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function renderWalletPage() {
  await refreshUserData();
  document.getElementById("walletBalance").textContent = `₨ ${formatMoney(userData.walletBalance || 0)}`;
  document.getElementById("walletEarned").textContent = `₨ ${formatMoney(userData.totalEarned || 0)}`;
  document.getElementById("walletSpent").textContent = `₨ ${formatMoney(userData.totalSpent || 0)}`;

  const txs = await loadTransactions();
  const el = document.getElementById("transactionsList");
  el.innerHTML = txs.length
    ? txs
        .map(
          (t) => `
      <div class="transaction-item ${t.type}">
        <span class="material-icons-round">${t.type === "credit" ? "arrow_downward" : "arrow_upward"}</span>
        <div class="tx-info">
          <strong>${escapeHtml(t.reason)}</strong>
          <small>${formatDate(t.createdAt)}</small>
        </div>
        <span class="tx-amount ${t.type}">${t.type === "credit" ? "+" : "−"} ₨ ${formatMoney(t.amount)}</span>
      </div>`
        )
        .join("")
    : emptyState("receipt_long", "No transactions yet", "Your wallet activity will show up here.");
}
async function cancelOrder(orderId) {
  if (!confirm("Are you sure you want to cancel this order?")) return;
  showSpinner(true);
  try {
    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) return showToast("Order not found", "error");
    const order = orderSnap.data();

    if (order.status !== "pending" && order.status !== "pending_verification") {
      return showToast("This order cannot be cancelled", "error");
    }

    // Check if order is within 3 days
    const orderDate = order.createdAt?.toDate ? order.createdAt.toDate() : new Date(order.createdAt);
    const daysDiff = (new Date() - orderDate) / (1000 * 60 * 60 * 24);
    if (daysDiff > 3) {
      return showToast("Cancellation period of 3 days has expired", "error");
    }

    await orderRef.update({ status: "cancelled" });

    // Refund wallet if wallet was used
    if (order.paymentMethod === "wallet" && order.walletUsed > 0) {
      await db.collection("users").doc(currentUser.uid).update({
        walletBalance: firebase.firestore.FieldValue.increment(order.walletUsed),
        totalSpent: firebase.firestore.FieldValue.increment(-order.walletUsed),
      });
      await logTransaction(currentUser.uid, "credit", order.walletUsed, "Refund for cancelled order", orderId);
    }

    // Reverse commissions if any were paid
    if (order.commissionsPaid && order.commissionsPaid.length > 0) {
      for (const c of order.commissionsPaid) {
        await db.collection("users").doc(c.uid).update({
          walletBalance: firebase.firestore.FieldValue.increment(-c.amount),
          totalEarned: firebase.firestore.FieldValue.increment(-c.amount),
        });
        await logTransaction(c.uid, "debit", c.amount, "Commission reversed due to order cancellation", orderId);
      }
    }

    // Restore stock
    for (const item of order.items) {
      await db.collection("products").doc(item.productId).update({
        stock: firebase.firestore.FieldValue.increment(item.qty),
      });
    }

    await notifyUser(currentUser.uid, "Order Cancelled", `Your order #${orderId.slice(0,8).toUpperCase()} has been cancelled.`);

    showToast("Order cancelled successfully", "success");
    await refreshUserData();
    renderOrders();
  } catch (err) {
    showToast("Error: " + err.message, "error");
  } finally {
    showSpinner(false);
  }
}
async function requestWithdrawal() {
  if (!userData.walletBalance || userData.walletBalance <= 0) {
    return showToast("No balance available to withdraw", "error");
  }
  showSpinner(true);
  try {
    await db.collection("withdrawalRequests").add({
      uid: currentUser.uid,
      amount: userData.walletBalance,
      status: "pending",
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    showToast("Withdrawal request submitted. We'll process it shortly.", "success");
  } catch (err) {
    showToast("Failed to submit withdrawal request", "error");
  } finally {
    showSpinner(false);
  }
}

/* =====================================================================
   ORDERS
===================================================================== */
let currentOrderFilter = "all";

async function renderOrders() {
  const snap = await db
    .collection("orders")
    .where("buyerUid", "==", currentUser.uid)
    .orderBy("createdAt", "desc")
    .get();
  const orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  window.__cachedOrders = orders;
  paintOrders(orders);
}

// FIX 2: filterOrders now only does its own job — no nested functions inside it.
function filterOrders(status) {
  currentOrderFilter = status;
  document.querySelectorAll(".order-tab").forEach((t) => t.classList.remove("active"));
  event.target.classList.add("active");
  paintOrders(window.__cachedOrders || []);
}

// FIX 2 (cont): openOrderTracking and closeOrderTracking are now proper top-level functions.
function openOrderTracking(orderId) {
  const order = (window.__cachedOrders || []).find(o => o.id === orderId);
  if (!order) return;

  const steps = ["pending", "confirmed", "shipped", "delivered"];
  const currentStep = steps.indexOf(order.status);

  const stepsHTML = steps.map((step, i) => `
    <div style="display:flex;align-items:center;gap:0;flex:1;flex-direction:column">
      <div style="width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;
        background:${i <= currentStep ? 'var(--primary)' : 'var(--surface-alt)'};
        color:${i <= currentStep ? '#fff' : 'var(--text-muted)'};
        border:2px solid ${i <= currentStep ? 'var(--primary)' : 'var(--border)'}">
        <span class="material-icons-round" style="font-size:16px">
          ${i < currentStep ? 'check' : i === 0 ? 'receipt' : i === 1 ? 'thumb_up' : i === 2 ? 'local_shipping' : 'home'}
        </span>
      </div>
      <span style="font-size:10px;margin-top:6px;font-weight:600;color:${i <= currentStep ? 'var(--primary-dark)' : 'var(--text-muted)'};text-transform:capitalize">${step}</span>
    </div>
    ${i < steps.length - 1 ? `<div style="flex:1;height:2px;margin-top:-22px;background:${i < currentStep ? 'var(--primary)' : 'var(--border)'}"></div>` : ''}
  `).join("");

  const itemsHTML = order.items.map(i => `
    <div style="display:flex;justify-content:space-between;font-size:13px;padding:8px 0;border-bottom:1px dashed var(--border)">
      <span>${escapeHtml(i.name)} × ${i.qty}</span>
      <span style="font-weight:700">₨ ${formatMoney(i.price * i.qty)}</span>
    </div>`).join("");

  document.getElementById("orderTrackingContent").innerHTML = `
    <div style="margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:12px;color:var(--text-muted)">ORDER</span>
        <span class="order-status status-${order.status}">${order.status}</span>
      </div>
      <strong style="font-size:15px">#${order.id.slice(0,8).toUpperCase()}</strong>
      <p style="font-size:12px;color:var(--text-muted);margin-top:2px">${formatDate(order.createdAt)}</p>
    </div>

    <div style="display:flex;align-items:center;margin-bottom:28px">
      ${stepsHTML}
    </div>

    <div style="background:var(--surface-alt);border-radius:var(--radius-md);padding:14px;margin-bottom:16px">
      <strong style="font-size:13px;display:block;margin-bottom:10px">
        <span class="material-icons-round" style="font-size:16px;vertical-align:middle">location_on</span>
        Delivery Address
      </strong>
      <p style="font-size:13px;color:var(--text-secondary)">${escapeHtml(order.address?.name || '')} · ${escapeHtml(order.address?.phone || '')}</p>
      <p style="font-size:13px;color:var(--text-secondary)">${escapeHtml(order.address?.address || '')}, ${escapeHtml(order.address?.city || '')} ${escapeHtml(order.address?.postal || '')}</p>
    </div>

    <div style="margin-bottom:16px">
      <strong style="font-size:13px;display:block;margin-bottom:10px">Items</strong>
      ${itemsHTML}
    </div>

    <div style="display:flex;justify-content:space-between;font-size:15px;font-weight:800;padding-top:10px">
      <span>Total</span>
      <span>₨ ${formatMoney(order.total)}</span>
    </div>`;

  document.getElementById("orderTrackingOverlay").classList.add("active");
}

function closeOrderTracking() {
  document.getElementById("orderTrackingOverlay").classList.remove("active");
}

function paintOrders(orders) {
  const filtered = currentOrderFilter === "all" ? orders : orders.filter((o) => o.status === currentOrderFilter);
  const el = document.getElementById("ordersList");
  el.innerHTML = filtered.length
    ? filtered
        .map(
          (o) => `
      <div class="order-card">
        <div class="order-header">
          <span class="order-id">#${o.id.slice(0, 8).toUpperCase()}</span>
          <span class="order-status status-${o.status}">${o.status.replace(/_/g, ' ')}</span>
        </div>
        <div class="order-items-preview">
          ${o.items.map((i) => `
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
              <img src="${allProducts.find(p => p.id === i.productId)?.image || 'https://placehold.co/300x300/eef2ff/6366f1?text=Product'}"
                style="width:52px;height:52px;object-fit:cover;border-radius:10px;border:1px solid #e2e8f0;flex-shrink:0;background:#f1f5f9"
                onerror="this.src='https://placehold.co/300x300/eef2ff/6366f1?text=Product'" />
              <span style="font-size:13px;font-weight:500;color:var(--text)">${escapeHtml(i.name)} × ${i.qty}</span>
            </div>`).join("")}
        </div>
        <div class="order-footer">
          <span>${formatDate(o.createdAt)}</span>
          <strong>₨ ${formatMoney(o.total)}</strong>
        </div>
        <button class="btn-outline full-width" style="margin-top:10px;padding:8px" onclick="openOrderTracking('${o.id}')">
  <span class="material-icons-round" style="font-size:16px">local_shipping</span> Track Order
</button>
${(() => {
  if (o.status !== 'pending' && o.status !== 'pending_verification') return '';
  const orderDate = o.createdAt?.toDate ? o.createdAt.toDate() : new Date(o.createdAt);
  const daysDiff = (new Date() - orderDate) / (1000 * 60 * 60 * 24);
  const daysLeft = Math.ceil(3 - daysDiff);
  if (daysDiff > 3) return `<p style="text-align:center;font-size:12px;color:var(--danger);margin-top:8px">❌ Cancellation period expired</p>`;
  return `
    <button class="btn-cancel full-width" style="margin-top:8px;padding:8px" onclick="cancelOrder('${o.id}')">
      <span class="material-icons-round" style="font-size:16px">cancel</span> Cancel Order
    </button>
    <p style="text-align:center;font-size:11px;color:var(--text-muted);margin-top:4px">⏳ ${daysLeft} day${daysLeft === 1 ? '' : 's'} left to cancel</p>`;
})()}
      </div>`
        )
        .join("")
    : emptyState("receipt_long", "No orders here", "Orders matching this filter will appear here.");
}

/* =====================================================================
   REFERRAL PAGE
===================================================================== */
function renderInviteCode() {
  document.getElementById("inviteCode").textContent = userData?.inviteCode || "—";
}

function copyInviteCode() {
  navigator.clipboard.writeText(userData?.inviteCode || "");
  showToast("Invite code copied!", "success");
}

function shareInvite() {
  const link = `${window.location.origin}${window.location.pathname}?ref=${userData?.inviteCode}`;
  if (navigator.share) {
    navigator.share({ title: "Join ShopEarn", text: "Shop and earn with me on ShopEarn!", url: link });
  } else {
    navigator.clipboard.writeText(link);
    showToast("Invite link copied!", "success");
  }
}

async function renderReferralTree() {
  const snap = await db.collection("users").where("l1InviterUid", "==", currentUser.uid).get();
  const directs = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));

  const el = document.getElementById("referralTree");
  document.getElementById("statReferrals").textContent = directs.length;
  document.getElementById("pcReferrals").textContent = directs.length;

  // Show activation banner
  renderActivationBanner();

  el.innerHTML = directs.length
    ? directs.map((u) => `
      <div class="referral-node">
        <img src="${u.photoURL || avatarFallback(u.name)}" alt="${escapeHtml(u.name)}" />
        <div class="referral-node-info">
          <strong>${escapeHtml(u.name)}</strong>
          <span class="referral-status ${isUserActiveThisMonth(u) ? "active" : "inactive"}">
            ${isUserActiveThisMonth(u) ? "Active this month" : "Inactive — hasn't renewed"}
          </span>
        </div>
      </div>`).join("")
    : emptyState("people_outline", "No referrals yet", "Share your invite code to start earning.");
}

function renderActivationBanner() {
  const banner = document.getElementById("activationBanner");
  if (!banner) return;

  const active = isUserActiveThisMonth(userData);

  if (active) {
    banner.style.display = "block";
    banner.innerHTML = `
      <div style="background:var(--success-bg);border:1.5px solid #a7f3d0;border-radius:var(--radius-md);padding:16px;display:flex;align-items:center;gap:12px">
        <span class="material-icons-round" style="color:var(--success);font-size:28px">check_circle</span>
        <div style="flex:1">
          <strong style="display:block;font-size:14px;color:#047857">Your code is Active this month!</strong>
          <p style="font-size:12.5px;color:#065f46;margin-top:2px">You are earning commissions from your referrals.</p>
        </div>
      </div>`;
  } else {
    banner.style.display = "block";
    banner.innerHTML = `
      <div style="background:var(--danger-bg);border:1.5px solid #fca5a5;border-radius:var(--radius-md);padding:16px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
          <span class="material-icons-round" style="color:var(--danger);font-size:28px">cancel</span>
          <div>
            <strong style="display:block;font-size:14px;color:#b91c1c">Your referral code is Inactive!</strong>
            <p style="font-size:12.5px;color:#991b1b;margin-top:2px">Pay ₨${ACTIVATION_FEE} to activate and start earning commissions.</p>
          </div>
        </div>

        <div style="background:var(--surface);border-radius:var(--radius-sm);padding:14px;margin-bottom:12px">
          <p style="font-size:13px;font-weight:600;margin-bottom:10px">Choose payment method:</p>
          <div style="display:flex;flex-direction:column;gap:8px">
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
              <input type="radio" name="activationMethod" value="wallet" checked /> 
              Wallet Balance (₨${formatMoney(userData.walletBalance || 0)} available)
            </label>
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
              <input type="radio" name="activationMethod" value="jazzcash" /> 
              JazzCash
            </label>
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
              <input type="radio" name="activationMethod" value="easypaisa" /> 
              EasyPaisa
            </label>
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
              <input type="radio" name="activationMethod" value="bank" /> 
              Bank Transfer
            </label>
          </div>
        </div>

        <div id="activationTxnBox" style="display:none;margin-bottom:12px">
          <p style="font-size:12.5px;color:var(--text-secondary);margin-bottom:8px">
            Send ₨${ACTIVATION_FEE} to: <strong>03368733364 (JazzCash/EasyPaisa)</strong> or bank account <strong>1234567890 (HBL)</strong>
          </p>
          <div class="input-group">
            <span class="material-icons-round">tag</span>
            <input type="text" id="activationTxnId" placeholder="Enter Transaction ID after payment" />
          </div>
        </div>

        <button class="btn-primary full-width" onclick="activateReferralCode()">
          <span class="material-icons-round">bolt</span> Activate for ₨${ACTIVATION_FEE}
        </button>
      </div>`;

    // Show/hide txn box based on payment method
    document.querySelectorAll('input[name="activationMethod"]').forEach(radio => {
      radio.addEventListener("change", (e) => {
        const txnBox = document.getElementById("activationTxnBox");
        txnBox.style.display = e.target.value === "wallet" ? "none" : "block";
      });
    });
  }
}
async function activateReferralCode() {
  const method = document.querySelector('input[name="activationMethod"]:checked')?.value || "wallet";

  if (method === "wallet") {
    if ((userData.walletBalance || 0) < ACTIVATION_FEE) {
      return showToast(`Insufficient wallet balance. Need ₨${ACTIVATION_FEE}`, "error");
    }
    showSpinner(true);
    try {
      // Deduct fee from wallet
      await db.collection("users").doc(currentUser.uid).update({
        walletBalance: firebase.firestore.FieldValue.increment(-ACTIVATION_FEE),
        totalSpent: firebase.firestore.FieldValue.increment(ACTIVATION_FEE),
        activeMonthKey: currentMonthKey(),
      });
      await logTransaction(currentUser.uid, "debit", ACTIVATION_FEE, "Monthly referral code activation fee");
      await notifyUser(currentUser.uid, "Code Activated!", "Your referral code is now active. Start earning commissions!");
      await refreshUserData();
      showToast("Referral code activated successfully! 🎉", "success");
      renderActivationBanner();
    } catch (err) {
      showToast("Error: " + err.message, "error");
    } finally {
      showSpinner(false);
    }
  } else {
    // Online payment — submit activation request for admin to verify
    const txnId = document.getElementById("activationTxnId")?.value.trim();
    if (!txnId) return showToast("Please enter your transaction ID", "error");

    showSpinner(true);
    try {
      await db.collection("activationRequests").add({
        uid: currentUser.uid,
        name: userData.name,
        email: userData.email,
        amount: ACTIVATION_FEE,
        method,
        txnId,
        status: "pending",
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      showToast("Activation request submitted! Admin will verify and activate your code shortly.", "success");
    } catch (err) {
      showToast("Error: " + err.message, "error");
    } finally {
      showSpinner(false);
    }
  }
}

/* =====================================================================
   NOTIFICATIONS
===================================================================== */
async function notifyUser(uid, title, body) {
  await db.collection("notifications").add({
    uid,
    title,
    body,
    read: false,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

async function loadNotificationsBadge() {
  const snap = await db
    .collection("notifications")
    .where("uid", "==", currentUser.uid)
    .where("read", "==", false)
    .get();
  const badge = document.getElementById("notifBadge");
  badge.textContent = snap.size;
  badge.style.display = snap.size > 0 ? "inline-flex" : "none";
}

async function renderNotifications() {
  const snap = await db
    .collection("notifications")
    .where("uid", "==", currentUser.uid)
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();
  const notifs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const el = document.getElementById("notificationsList");
  el.innerHTML = notifs.length
    ? notifs
        .map(
          (n) => `
      <div class="notification-item ${n.read ? "" : "unread"}" onclick="markNotificationRead('${n.id}')">
        <span class="material-icons-round">notifications</span>
        <div>
          <strong>${escapeHtml(n.title)}</strong>
          <p>${escapeHtml(n.body)}</p>
          <small>${formatDate(n.createdAt)}</small>
        </div>
      </div>`
        )
        .join("")
    : emptyState("notifications_none", "No notifications", "You're all caught up.");

  await db
    .collection("notifications")
    .where("uid", "==", currentUser.uid)
    .where("read", "==", false)
    .get()
    .then((s) => loadNotificationsBadge());
}

async function markNotificationRead(id) {
  await db.collection("notifications").doc(id).update({ read: true });
  loadNotificationsBadge();
}

/* =====================================================================
   PROFILE
===================================================================== */
function renderProfile() {
  if (!userData) return;
  document.getElementById("profileName").textContent = userData.name;
  document.getElementById("profileEmail").textContent = userData.email;
  document.getElementById("profileAvatar").src = userData.photoURL || avatarFallback(userData.name, 100);
  document.getElementById("headerAvatar").src = userData.photoURL || avatarFallback(userData.name, 40);
  db.collection("orders").where("buyerUid", "==", currentUser.uid).get()
  .then(snap => {
    document.getElementById("pcOrders").textContent = snap.size;
    document.getElementById("statOrders").textContent = snap.size;
  });
  document.getElementById("pcWallet").textContent = `₨ ${formatMoney(userData.walletBalance || 0)}`;
  document.getElementById("pcWishlist").textContent = userData.wishlist?.length || 0;

  const level = getUserLevel(userData);
  document.getElementById("profileBadge").textContent = level;
  document.getElementById("statLevel").textContent = level;
}

function getUserLevel(u) {
  const earned = u.totalEarned || 0;
  if (earned >= 50000) return "Elite";
  if (earned >= 10000) return "Pro";
  if (earned >= 1000) return "Rising";
  return "Starter";
}

function changeAvatar() {
  showToast("Avatar upload coming soon", "success");
}

function renderHomeStats() {
  if (!userData) return;
  document.getElementById("heroEarnings").textContent = `₨ ${formatMoney(userData.totalEarned || 0)}`;
  document.getElementById("statWallet").textContent = `₨ ${formatMoney(userData.walletBalance || 0)}`;
}

/* =====================================================================
   NAVIGATION
===================================================================== */
function renderEditProfile() {
  const el = document.getElementById("editProfilePage");
  if (!el || !userData) return;
  el.innerHTML = `
    <h2 class="section-title">
      <span class="material-icons-round">edit</span> Edit Profile
    </h2>
    <div class="profile-hero" style="margin-bottom:20px">
      <div class="profile-avatar-wrap">
        <img id="editAvatar" src="${userData.photoURL || avatarFallback(userData.name, 100)}" style="width:78px;height:78px;border-radius:50%;object-fit:cover;border:3px solid var(--primary-50)" />
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="input-group">
        <span class="material-icons-round">person</span>
        <input type="text" id="editName" placeholder="Full Name" value="${escapeHtml(userData.name || '')}" />
      </div>
      <div class="input-group">
        <span class="material-icons-round">email</span>
        <input type="text" id="editEmail" placeholder="Email" value="${escapeHtml(userData.email || '')}" disabled style="opacity:0.5" />
      </div>
      <div class="input-group">
        <span class="material-icons-round">phone</span>
        <input type="tel" id="editPhone" placeholder="Phone Number" value="${escapeHtml(userData.phone || '')}" />
      </div>
      <div class="input-group">
        <span class="material-icons-round">image</span>
        <input type="text" id="editPhotoURL" placeholder="Photo URL (paste image link)" value="${escapeHtml(userData.photoURL || '')}" oninput="document.getElementById('editAvatar').src=this.value||avatarFallback('${escapeHtml(userData.name || 'U')}')" />
      </div>
      <button class="btn-primary full-width" onclick="saveProfile()">
        <span class="material-icons-round">save</span> Save Changes
      </button>
      <button class="btn-outline full-width" onclick="showPage('profile')">
        Cancel
      </button>
    </div>`;
}

async function saveProfile() {
  const name     = document.getElementById("editName").value.trim();
  const phone    = document.getElementById("editPhone").value.trim();
  const photoURL = document.getElementById("editPhotoURL").value.trim();
  if (!name) return showToast("Name cannot be empty", "error");
  showSpinner(true);
  try {
    await db.collection("users").doc(currentUser.uid).update({ name, phone, photoURL });
    userData.name     = name;
    userData.phone    = phone;
    userData.photoURL = photoURL;
    renderProfile();
    showToast("Profile updated!", "success");
    showPage("profile");
  } catch(err) {
    showToast(err.message, "error");
  } finally {
    showSpinner(false);
  }
}

function showPage(page) {
  sessionStorage.setItem("currentPage", page);
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));

  const pageMap = {
    home: "homePage",
    shop: "shopPage",
    product: "productPage",
    cart: "cartPage",
    wishlist: "wishlistPage",
    orders: "ordersPage",
    wallet: "walletPage",
    referral: "referralPage",
    profile: "profilePage",
    editProfile: "editProfilePage",
    notifications: "notificationsPage",
    categories: "categoriesPage",
    search: "searchPage",
    checkout: "checkoutPage",
  };

  const target = document.getElementById(pageMap[page]);
  if (target) target.classList.add("active");

  const navBtn = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (navBtn) navBtn.classList.add("active");

  // Lazy-render the page being navigated to
  if (page === "cart") renderCart();
  if (page === "wishlist") renderWishlist();
  if (page === "orders") renderOrders();
  if (page === "wallet") renderWalletPage();
  if (page === "referral") renderReferralTree();
  if (page === "notifications") renderNotifications();
  if (page === "categories") {
  document.getElementById("catTotalCount").textContent = `${categories.length} categories`;
  renderCategoriesGrid();
}
  if (page === "shop") renderShopProducts();
  if (page === "editProfile") renderEditProfile();

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");

  sidebar.classList.toggle("open");
  overlay.classList.toggle("active");

  updateHeaderForSidebar();
}

function updateHeaderForSidebar() {
  const sidebar = document.getElementById("sidebar");
  const header = document.querySelector(".header");
  const pageContainer = document.querySelector(".page-container");
  const isOpen = sidebar.classList.contains("open");

  if (window.innerWidth >= 1024) {
    if (isOpen) {
      header.style.left = "268px";
      header.style.right = "0px";
      header.style.width = "auto";
      pageContainer.style.marginLeft = "268px";
    } else {
      header.style.left = "0px";
      header.style.right = "0px";
      header.style.width = "100%";
      pageContainer.style.marginLeft = "0px";
    }
  } else {
    header.style.left = "0px";
    header.style.right = "0px";
    header.style.width = "100%";
    pageContainer.style.marginLeft = "0px";
  }
}

/* =====================================================================
   FLASH SALE COUNTDOWN
===================================================================== */
function startFlashSaleCountdown() {
  // Countdown to the end of the current day (adjust as needed)
  const getTarget = () => {
    const t = new Date();
    t.setHours(23, 59, 59, 999);
    return t;
  };
  let target = getTarget();

  countdownInterval = setInterval(() => {
    const now = new Date();
    let diff = target - now;
    if (diff <= 0) {
      target = getTarget();
      diff = target - now;
    }
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    document.getElementById("cdH").textContent = String(h).padStart(2, "0");
    document.getElementById("cdM").textContent = String(m).padStart(2, "0");
    document.getElementById("cdS").textContent = String(s).padStart(2, "0");
  }, 1000);
}

/* =====================================================================
   UTILITIES
===================================================================== */
function showSpinner(show) {
  document.getElementById("loadingSpinner").classList.toggle("active", show);
}

function showToast(message, type = "success") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  setTimeout(() => toast.classList.remove("show"), 3000);
}

function formatMoney(n) {
  return Number(n || 0).toLocaleString("en-PK", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatDate(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function placeholderImg() {
  return "https://placehold.co/300x300/eef2ff/6366f1?text=Product";
}

function avatarFallback(name, size = 40) {
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(name || "U")}&background=6366f1&color=fff&size=${size}`;
}

function emptyState(icon, title, subtitle) {
  return `
    <div class="empty-state">
      <span class="material-icons-round">${icon}</span>
      <h3>${title}</h3>
      <p>${subtitle}</p>
    </div>`;
}

/* =====================================================================
   AUTO-APPLY REFERRAL CODE FROM URL (?ref=CODE) ON FIRST LOAD
===================================================================== */
(function autoFillReferralFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const ref = params.get("ref");
  if (ref) {
    document.addEventListener("DOMContentLoaded", () => {
      const input = document.getElementById("regReferral");
      if (input) input.value = ref.toUpperCase();
      switchAuthTab("register");
    });
  }
})();
window.addEventListener("resize", updateHeaderForSidebar);
