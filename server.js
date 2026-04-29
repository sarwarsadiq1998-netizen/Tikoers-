require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const { TikTokLiveConnector } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-key',
  resave: false,
  saveUninitialized: true
}));

// التخزين المؤقت بالذاكرة (بدون قاعدة بيانات)
const users = {};

//------------------------- دوال مساعدة -------------------------
function startWatching(streamerUsername, ownerUsername) {
  if (!streamerUsername) return;
  const tiktok = new TikTokLiveConnector();
  tiktok.connect(streamerUsername);
  tiktok.on('connected', () => console.log(`✅ متصل ببث @${streamerUsername} لحساب ${ownerUsername}`));
  
  tiktok.on('like', (data) => {
    const user = users[ownerUsername];
    if (!user) return;
    user.totalLikes = (user.totalLikes || 0) + (data.likeCount || 1);
    if (!user.topLikers) user.topLikers = {};
    const viewerId = data.uniqueId;
    user.topLikers[viewerId] = (user.topLikers[viewerId] || 0) + (data.likeCount || 1);
    
    const top5 = Object.entries(user.topLikers)
      .sort((a,b) => b[1] - a[1])
      .slice(0,5)
      .map(([id, count]) => ({ id, count }));
    
    io.to(streamerUsername).emit('live-update', {
      totalLikes: user.totalLikes,
      top5: top5
    });
  });

  tiktok.on('gift', (data) => {
    const mainAccount = process.env.MAIN_TIKTOK_USERNAME;
    const requiredGift = parseInt(process.env.SUBSCRIPTION_GIFT_VALUE || '500');
    if (streamerUsername === mainAccount && data.diamondCount >= requiredGift) {
      const buyer = Object.values(users).find(u => u.streamerUsername === data.uniqueId);
      if (buyer) {
        const expiry = new Date();
        expiry.setMonth(expiry.getMonth() + 1);
        buyer.subscribedUntil = expiry;
        console.log(`🎉 تم تفعيل الاشتراك للمستخدم ${buyer.username} حتى ${expiry.toISOString()}`);
        io.to(buyer.username).emit('subscription-active', { until: expiry });
      }
    }
  });
}

//------------------------- واجهات الويب -------------------------
app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.redirect('/dashboard');
});

app.get('/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>دخول / تسجيل</title></head>
    <body style="background:#111;color:#0f0;font-family:monospace;text-align:center;padding:50px;">
      <h2>🎮 منصة ألعاب تيك توك</h2>
      <form method="post" action="/login">
        <input name="username" placeholder="اسم المستخدم" required><br><br>
        <input name="password" type="password" placeholder="كلمة السر" required><br><br>
        <button type="submit">دخول</button>
      </form>
      <form method="post" action="/register">
        <input name="username" placeholder="اسم مستخدم جديد" required><br><br>
        <input name="password" type="password" placeholder="كلمة سر جديدة" required><br><br>
        <button type="submit">إنشاء حساب (48 ساعة تجريبية)</button>
      </form>
    </body>
    </html>
  `);
});

app.post('/register', (req, res) => {
  const { username, password } = req.body;
  if (users[username]) return res.send('المستخدم موجود بالفعل');
  const trialExpiry = new Date();
  trialExpiry.setHours(trialExpiry.getHours() + 48);
  users[username] = {
    password,
    subscribedUntil: trialExpiry,
    streamerUsername: null,
    totalLikes: 0,
    topLikers: {}
  };
  req.session.user = username;
  res.redirect('/dashboard');
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (user && user.password === password) {
    req.session.user = username;
    res.redirect('/dashboard');
  } else {
    res.send('بيانات غير صحيحة');
  }
});

app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const user = users[req.session.user];
  const isActive = user.subscribedUntil && new Date() < user.subscribedUntil;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>لوحة التحكم</title></head>
    <body style="background:#111;color:#0f0;font-family:monospace;padding:20px;text-align:center;">
      <h1>مرحباً ${req.session.user}</h1>
      <p>${isActive ? '✅ اشتراك نشط' : '❌ اشتراك منتهي أو تجريبي'}</p>
      <p>${user.streamerUsername ? `📺 حساب تيك توك المرتبط: ${user.streamerUsername}` : '⚠️ لم تقم بربط حساب تيك توك بعد'}</p>
      <form method="post" action="/set-streamer">
        <input name="streamerUsername" placeholder="اسم حسابك على تيك توك" value="${user.streamerUsername || ''}" required>
        <button type="submit">ربط الحساب</button>
      </form>
      <h3>🔗 رابط البث الخاص بك:</h3>
      <input value="https://${req.headers.host}/overlay/${req.session.user}" id="link" readonly style="width:80%">
      <button onclick="navigator.clipboard.writeText(document.getElementById('link').value)">نسخ الرابط</button>
      <p>ضع هذا الرابط في OBS كمصدر Browser Source</p>
      <hr>
      <h3>💎 تفعيل الاشتراك الشهري (بعد انتهاء التجربة):</h3>
      <p>أرسل هدية بقيمة <strong>${process.env.SUBSCRIPTION_GIFT_VALUE || '500'}</strong> 💎 إلى حساب TikTok الرئيسي: <strong>@${process.env.MAIN_TIKTOK_USERNAME || 'your_account'}</strong> من حسابك الذي ربطته أعلاه، وسيتم تفعيل اشتراكك تلقائياً لمدة شهر.</p>
      <a href="/logout">تسجيل خروج</a>
    </body>
    </html>
  `);
});

app.post('/set-streamer', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const user = users[req.session.user];
  user.streamerUsername = req.body.streamerUsername;
  startWatching(user.streamerUsername, req.session.user);
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/overlay/:userId', (req, res) => {
  const userId = req.params.userId;
  const user = users[userId];
  if (!user) return res.status(404).send('مستخدم غير موجود');
  const isActive = user.subscribedUntil && new Date() < user.subscribedUntil;
  if (!isActive) {
    return res.send(`
      <div style="background:#222;color:red;padding:20px;text-align:center;font-family:sans-serif;">
        ⚠️ اشتراكك منتهي. يرجى تجديد الاشتراك عبر إرسال هدية بقيمة ${process.env.SUBSCRIPTION_GIFT_VALUE || '500'} إلى @${process.env.MAIN_TIKTOK_USERNAME || 'your_account'}.
      </div>
    `);
  }
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>تراكب ${userId}</title>
    <style>
      *{margin:0;padding:0;box-sizing:border-box;}
      body{background:rgba(0,0,0,0.75);font-family:'Segoe UI',sans-serif;direction:rtl;padding:20px;}
      .likes{background:#ff0050;padding:10px 20px;border-radius:40px;display:inline-block;font-weight:bold;margin-bottom:20px;}
      ul{list-style:none;}
      li{margin:8px 0;padding:8px 15px;background:rgba(0,0,0,0.5);border-radius:40px;display:flex;justify-content:space-between;border-right:4px solid transparent;}
      .rank-1{border-right-color:#FFD700;background:linear-gradient(95deg,#2a2410,#1f1a08);}
      .rank-2{border-right-color:#C0C0C0;}
      .rank-3{border-right-color:#CD7F32;}
    </style>
    <script src="/socket.io/socket.io.js"></script>
    </head>
    <body>
      <div class="likes">❤️ عداد اللايكات: <span id="likes">0</span></div>
      <ul id="top5"></ul>
      <script>
        const socket = io();
        socket.emit('join-room', '${user.streamerUsername || userId}');
        socket.on('live-update', (data) => {
          document.getElementById('likes').innerText = data.totalLikes || 0;
          const list = document.getElementById('top5');
          list.innerHTML = (data.top5 || []).map((v,i) => '<li class="rank-'+(i+1)+'"><span>'+(i+1)+'. '+v.id+'</span><span>❤️ '+v.count+'</span></li>').join('');
        });
      </script>
    </body>
    </html>
  `);
});

io.on('connection', (socket) => {
  socket.on('join-room', (room) => {
    socket.join(room);
    console.log(`انضم إلى غرفة ${room}`);
  });
});

// بدء مراقبة الحساب الرئيسي لاستقبال هدايا الاشتراكات
if (process.env.MAIN_TIKTOK_USERNAME) {
  startWatching(process.env.MAIN_TIKTOK_USERNAME, 'system');
} else {
  console.warn('⚠️ الرجاء تعيين MAIN_TIKTOK_USERNAME في متغيرات البيئة');
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 الخادم يعمل على http://localhost:${PORT}`);
});
