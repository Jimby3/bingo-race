/***********************************************************************
 * Minimal Express + Socket.IO server for a custom-size Bingo race
 * - One creator starts the game, no “ready” system
 * - Square board of any dimension (≥2)
 * - Optional custom goal list supplied at room creation
 **********************************************************************/
const express = require('express');
const app     = express();
const server  = require('http').createServer(app);
const io      = require('socket.io')(server);

app.use(express.static('public'));   // serves index.html, CSS, JS, etc.

/* ──────────────────── In-memory room storage ──────────────────── */
const rooms = {};
const ROOM_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds
const roomTimers = new Map();

/* ------------------------------------------------------------------
 * generateBoard(size, customData?)
 *   size        – square dimension (int)
 *   customData  – array of goal strings (size² items) or null
 * Returns 2-D array of cell objects:
 *   { value, state:'', ownerId:null, color:null }
 * ------------------------------------------------------------------ */
function generateBoard(size, goalList) {
    if (!goalList || !Array.isArray(goalList)) {
        throw new Error('A goal list is required');
    }

    // Randomly select size*size items from the goal list
    const selectedGoals = [...goalList]
        .sort(() => Math.random() - 0.5)
        .slice(0, size * size);

    return Array.from({ length: size }, (_, r) =>
        Array.from({ length: size }, (_, c) => ({
            value: selectedGoals[r * size + c],
            state: '',
            ownerId: null,
            color: null
        }))
    );
}

/* pick an unused colour from palette, fall back to random hex */
function nextColor(players){
    const palette = [
        '#FF61E6',   // Neon pink
        '#00FFBB',   // Cyber mint
        '#84FF3C',   // Electric lime
        '#FFB938',   // Cosmic orange
        '#FF4D8C',   // Hot coral
        '#41CAFF',   // Bright sky blue
        '#B275FF',   // Bright purple
        '#FFE668'    // Warm yellow
    ];
    const used = new Set(players.map(p=>p.color));
    const free = palette.filter(c=>!used.has(c));
    return free.length
        ? free[Math.floor(Math.random()*free.length)]
        : `#${Math.floor(Math.random()*0xffffff).toString(16).padStart(6,'0')}`;
}

function updateScores(room, roomId) {
    // Count squares for each player
    const playerScores = {};
    room.players.forEach(player => {
        playerScores[player.id] = 0;
    });

    // Count marked squares
    for (let row of room.board) {
        for (let cell of row) {
            if (cell.state === 'X' && cell.ownerId) {
                playerScores[cell.ownerId]++;
            }
        }
    }

    // Update player scores
    room.players.forEach(player => {
        player.score = playerScores[player.id];
    });

    // Emit updated scores
    io.to(roomId).emit('scores-updated', { players: room.players });
}

function resetRoomTimer(roomId) {
    // Clear existing timer
    if (roomTimers.has(roomId)) {
        clearTimeout(roomTimers.get(roomId));
    }

    // Set new timer
    const timer = setTimeout(() => {
        if (rooms[roomId]) {
            io.to(roomId).emit('room-timeout', 'Room closed due to inactivity');
            delete rooms[roomId];
            roomTimers.delete(roomId);
        }
    }, ROOM_TIMEOUT);

    roomTimers.set(roomId, timer);
}

/* ──────────────────── Socket.IO lifecycle ──────────────────── */
io.on('connection', socket => {
    /* CREATE ROOM ---------------------------------------------------- */
    socket.on('create-room', ({ roomId, username, size, goalList }) => {
        if (rooms[roomId]) return socket.emit('room-error', 'Room already exists');
        if (!goalList || goalList.length < size * size) {
            return socket.emit('room-error', `Need at least ${size * size} goals in the list`);
        }

        rooms[roomId] = {
            size,
            board: generateBoard(size, goalList),
            goalList,                  // store for future games
            players: [],
            gameStarted: false,
            winner: null,
            creator: socket.id
        };

        const color = nextColor([]);
        rooms[roomId].players.push({
            id: socket.id, username, color, score: 0, isCreator: true
        });

        socket.join(roomId);
        socket.emit('room-created', {
            roomId, board: rooms[roomId].board, size, players: rooms[roomId].players
        });
        resetRoomTimer(roomId);
    });

    /* JOIN ROOM ------------------------------------------------------ */
    socket.on('join-room', ({ roomId, username })=>{
        const room = rooms[roomId];
        if (!room)                 return socket.emit('room-error','Room does not exist');
        if (room.gameStarted)      return socket.emit('room-error','Game in progress');

        const color = nextColor(room.players);
        room.players.push({ id:socket.id, username, color, score:0, isCreator:false });

        socket.join(roomId);
        io.to(roomId).emit('player-joined', room.players);
        socket.emit('init', { roomId,
            board:room.board, size:room.size, players:room.players,
            gameStarted:room.gameStarted
        });
        resetRoomTimer(roomId);
    });

    /* START GAME (creator only) ------------------------------------- */
    socket.on('start-game', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || socket.id !== room.creator) return;

        room.gameStarted = true;
        room.winner = null;
        room.board = generateBoard(room.size, room.goalList);
        const startTime = Date.now();

        io.to(roomId).emit('game-start', {
            board: room.board, size: room.size, startTime
        });
    });

    /* CLAIM / UNCLAIM SQUARE ---------------------------------------- */
    socket.on('update-cell', ({ roomId, row, col }) => {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        const cell = room.board[row][col];

        /* toggle logic */
        if (cell.state === 'X' && cell.ownerId === socket.id) {
            Object.assign(cell, { state: '', ownerId: null, color: null });
        } else if (!cell.state) {
            Object.assign(cell, { state: 'X', ownerId: socket.id, color: player.color });
        }

        io.to(roomId).emit('cell-updated', {
            row, col, state: cell.state, color: cell.color, userId: cell.ownerId
        });

        updateScores(room, roomId);
        resetRoomTimer(roomId);
    });

    /* CHAT ----------------------------------------------------------- */
    socket.on('chat-message', ({ roomId, message })=>{
        const room = rooms[roomId];
        const sender = room?.players.find(p=>p.id===socket.id);
        if (!room || !sender) return;

        io.to(roomId).emit('chat-message',{
            username:sender.username, message, color:sender.color
        });
    });

    /* DISCONNECT ----------------------------------------------------- */
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            room.players = room.players.filter(p => p.id !== socket.id);
            io.to(roomId).emit('player-left', room.players);

            if (!room.players.length) {
                delete rooms[roomId];
                if (roomTimers.has(roomId)) {
                    clearTimeout(roomTimers.get(roomId));
                    roomTimers.delete(roomId);
                }
            }
        }
    });
});
/* start server */
server.listen(3000, ()=>console.log('Server running on http://localhost:3000'));
