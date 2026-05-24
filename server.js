//Esto es lo que esta alojado en mi servidor de EC2 la logica la colocamos aqui para poder modifcar klo que nseecitemos
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const { CognitoJwtVerifier } = require("aws-jwt-verify");

const app = express();

// Configura el verificador con tus datos de Cognito
// ATENCIÓN: Si cambias de User Pool o Cliente de Cognito, debes actualizar esto también en el backend
const verifier = CognitoJwtVerifier.create({
  userPoolId: "us-east-1_gXHISpjx9", // PONER AQUÍ EL NUEVO USER POOL ID
  tokenUse: "access",
  clientId: "6bnufkn09clee3f90m1uo38ev2", // PONER AQUÍ EL NUEVO APP CLIENT ID
});

// Middleware
app.use(cors()); 
app.use(express.json());

// Conexión a la base de datos RDS / Nueva BD
// ATENCIÓN: Si cambias de base de datos RDS o cambias las credenciales, actualiza estos valores
const db = mysql.createConnection({
    host: 'ecommerce-uaq-db.cl8me0gc0mau.us-east-1.rds.amazonaws.com', // Nuevo Endpoint de la BD o Instancia RDS
    user: 'admin', // Nuevo usuario maestro
    password: 'luisillo', // Nueva contraseña
    database: 'tienda_uaq' // Nombre de la nueva base de datos
});

db.connect((err) => {
    if (err) {
        console.error('Error al conectar a la BD:', err);
        return;
    }
    console.log('¡Conectado a la base de datos RDS exitosamente!');
});

// Ruta principal de prueba}
app.get('/', (req, res) => {
    res.send('API del E-commerce funcionando al 100%');
});

// Ruta para obtener todos los productos
app.get('/api/productos', (req, res) => {
    db.query('SELECT * FROM Productos', (err, results) => {
        if (err) {
            res.status(500).send('Error al consultar la base de datos');
        } else {
            res.json(results); // Devuelve los datos en formato JSON
        }
    });
});

// Ruta para procesar el checkout SEGURO
app.post('/api/checkout', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Token no proporcionado" });
    }

    const token = authHeader.split(' ')[1];
    let payload;

    // VULNERABILIDAD 2 RESUELTA: Verificación Criptográfica del Token
    try {
        payload = await verifier.verify(token);
    } catch (err) {
        console.error("Token inválido o expirado:", err);
        return res.status(403).json({ error: "Acceso denegado. Token inválido." });
    }

    const cognito_id = payload.sub; 
    const { items, usuario } = req.body;

    if (!items || items.length === 0) {
        return res.status(400).json({ error: "El carrito está vacío" });
    }

    // VULNERABILIDAD 1 RESUELTA: Calculamos el Total desde la BD
    let idsProductos = items.map(item => item.id);
    
    db.query('SELECT id, precio, stock FROM Productos WHERE id IN (?)', [idsProductos], (err, dbProductos) => {
        if (err) return res.status(500).json({ error: "Error de servidor al validar productos" });

        let totalCalculado = 0;
        let carritoValidado = [];

        for (let item of items) {
            let productoReal = dbProductos.find(p => p.id === item.id);
            if (!productoReal) return res.status(400).json({ error: `Producto con ID ${item.id} no existe.` });
            if (productoReal.stock < item.quantity) return res.status(400).json({ error: `Sin stock para el producto ID ${item.id}` });
            
            totalCalculado += parseFloat(productoReal.precio) * item.quantity;
            carritoValidado.push({
                id: productoReal.id,
                precio_real: productoReal.precio,
                cantidad: item.quantity
            });
        }

        // Ya calculamos todo seguro. Procedemos a insertar y buscar usuario.
        db.query('SELECT id FROM Usuarios WHERE cognito_id = ?', [cognito_id], (errU, resU) => {
            if (errU || !resU || resU.length === 0) {
                // Registrar este usuario nuevo
                const nombre = usuario?.nombre || "Usuario Cognito";
                const email = usuario?.email || "sin_correo";
                db.query('INSERT INTO Usuarios (cognito_id, nombre, email) VALUES (?, ?, ?)', [cognito_id, nombre, email], (eI, rI) => {
                    if(!eI) crearPedidoSeguro(rI.insertId, totalCalculado, carritoValidado);
                });
            } else {
                crearPedidoSeguro(resU[0].id, totalCalculado, carritoValidado);
            }
        });
    });

    function crearPedidoSeguro(dbUserId, granTotal, carritoValido) {
        db.query('INSERT INTO Pedidos (usuario_id, total, estado) VALUES (?, ?, ?)', [dbUserId, granTotal, 'Pagado'], (err, resultPedido) => {
            if (err) return res.status(500).json({ error: 'Error al crear pedido general' });
            
            let detalles = 0;
            let fallos = false;

            carritoValido.forEach(item => {
                db.query('INSERT INTO Detalle_Pedidos (pedido_id, producto_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)', 
                [resultPedido.insertId, item.id, item.cantidad, item.precio_real], (errDet) => {
                    if (errDet) fallos = true;
                    // Restamos stock
                    db.query('UPDATE Productos SET stock = GREATEST(0, stock - ?) WHERE id = ?', [item.cantidad, item.id]);
                    detalles++;
                    if (detalles === carritoValido.length) {
                        if (fallos) return res.status(500).json({ error: 'Pedido con fallos en detalles' });
                        res.json({ message: "Compra totalmente segura realizada", orderId: resultPedido.insertId });
                    }
                });
            });
        });
    }

    // La respuesta se maneja dentro de crearPedidoSeguro
});

// Ruta para obtener el historial de pedidos de un usuario
app.get('/api/mis-pedidos', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Token no proporcionado" });
    }

    const token = authHeader.split(' ')[1];
    let payload;

    try {
        payload = await verifier.verify(token);
    } catch (err) {
        return res.status(403).json({ error: "Acceso denegado. Token inválido." });
    }

    const cognito_id = payload.sub;

    // Primero buscamos el ID interno del usuario
    db.query('SELECT id FROM Usuarios WHERE cognito_id = ?', [cognito_id], (errU, resU) => {
        if (errU || !resU || resU.length === 0) {
            return res.json([]); // No tiene usuario registrado/pedidos
        }
        
        const dbUserId = resU[0].id;
        
        // Obtenemos los pedidos
        db.query('SELECT * FROM Pedidos WHERE usuario_id = ? ORDER BY fecha_compra DESC', [dbUserId], (errP, pedidos) => {
            if (errP) return res.status(500).json({ error: "Error consultando pedidos" });
            if (pedidos.length === 0) return res.json([]);

            const pedidosIds = pedidos.map(p => p.id);
            
            // Obtenemos los detalles de esos pedidos
            db.query(`
                SELECT dp.*, p.nombre, p.imagen_url 
                FROM Detalle_Pedidos dp
                JOIN Productos p ON dp.producto_id = p.id
                WHERE dp.pedido_id IN (?)
            `, [pedidosIds], (errDP, detalles) => {
                if (errDP) return res.status(500).json({ error: "Error consultando detalles" });

                // Estructuramos la respuesta
                const respuesta = pedidos.map(pedido => {
                    return {
                        ...pedido,
                        detalles: detalles.filter(d => d.pedido_id === pedido.id)
                    };
                });
                
                res.json(respuesta);
            });
        });
    });
});

// Iniciar el servidor
const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor Express corriendo en el puerto ${PORT}`);
});
