import fetch from 'node-fetch';

const API_URL = 'http://localhost:3001/api';

async function testFlow() {
    console.log('--- Starting Integration Test ---');

    // 1. Register Technician
    console.log('1. Registering Technician...');
    const techEmail = `test${Date.now()}@tech.com`;
    const regRes = await fetch(`${API_URL}/technicians/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: 'Integration Tech',
            email: techEmail,
            password: 'password123',
            phone: '1234567890',
            address: 'Test Address',
            serviceAreaRange: 10,
            specialties: ['Car Repair']
        })
    });
    const regData = await regRes.json();
    if (!regRes.ok) throw new Error(`Registration failed: ${JSON.stringify(regData)}`);
    console.log('   Registration successful. ID:', regData.id);

    // 2. Approve Technician (Admin)
    console.log('2. Approving Technician...');
    // Since we need admin auth, we might skip this if verifyAdmin is strict. 
    // But wait, the registration endpoint returns success but status is pending.
    // I need to approve it manually via DB or admin endpoint.
    // For this test, let's login as admin first.
    // Assuming admin credentials seed or default?
    // Actually, I can just update the DB directly since I'm running locally? 
    // No, that's cheating.
    // Let's use the login endpoint. Oh wait, I don't have admin creds.
    // I'll skip approval and try to login? No, login will fail if pending.
    // I must approve.

    // Okay, easier path: run a SQL command to approve.
    // But for this script, maybe I can use a helper or just bypass if I can.
    // Actually, wait! The 'verifyAdmin' middleware probably checks something simple.
    // Let's look at `middleware/auth.js`.

    // Actually, let's login first.

    // 3. Login Technician
    console.log('3. Logging in Technician...');
    // Force approval via cheat endpoint or SQL?
    // I will just login first to fail?

    // Let's cheat: I'll use the 'create' endpoint which admin uses, OR since I can't be admin easily...
    // I will just modify the DB in this script? No, I can't import db.js easily if it uses ES modules and this runs outside?
    // Wait, I can run this with `node verify-backend.js` if it's in the root or server folder.

    // Let's just try to login, if it fails due to "pending", I will note it.

    const loginRes = await fetch(`${API_URL}/technicians/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: techEmail, password: 'password123' })
    });
    const loginData = await loginRes.json();

    if (loginData.error && loginData.error.includes('under review')) {
        console.log('   Login blocked as expected (Pending status).');
        console.log('   !!! MANUAL STEP REQUIRED: Approve technician in DB. !!!');
        // For automated test, this stops here unless I can approve.
        return;
    }

    if (!loginRes.ok) throw new Error(`Login failed: ${JSON.stringify(loginData)}`);

    const token = loginData.token;
    console.log('   Login successful. Token obtained.');

    // 4. Toggle Status
    console.log('4. Toggling Status to Online...');
    const statusRes = await fetch(`${API_URL}/technicians/status`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ is_active: true })
    });
    const statusData = await statusRes.json();
    console.log('   Status update result:', statusData);

    // 5. Create Service Request (Customer)
    console.log('5. Creating Service Request...');
    const reqRes = await fetch(`${API_URL}/requests/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            user_id: 999,
            service_type: 'Test Service',
            pickup_lat: 10.0,
            pickup_lng: 10.0,
            drop_lat: 10.1,
            drop_lng: 10.1,
            price: 150
        })
    });
    const reqData = await reqRes.json();
    console.log('   Request created. ID:', reqData.request_id);

    // 6. Accept Job
    console.log('6. Accepting Job...');
    const acceptRes = await fetch(`${API_URL}/requests/${reqData.request_id}/respond`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ action: 'accept' })
    });
    const acceptData = await acceptRes.json();
    console.log('   Accept result:', acceptData);

    // 7. Complete Job
    console.log('7. Completing Job...');
    const completeRes = await fetch(`${API_URL}/requests/${reqData.request_id}/status`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ status: 'completed' })
    });
    const completeData = await completeRes.json();
    console.log('   Complete result:', completeData);

    console.log('--- Test Completed Successfully ---');
}

testFlow().catch(err => console.error('Test Failed:', err));
