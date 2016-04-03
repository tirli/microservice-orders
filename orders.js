const http = require('http');
const soap = require('soap');
const fs = require('fs');
const low = require('lowdb')
const storage = require('lowdb/file-sync')
const db = low('db.json', { storage })('orders');
const co = require('co');
const thenify = require('thenify');


function __(value) {
  return value.$value || value;
}

function toArray(x) {
  return Array.isArray(x) ? x : [x];
}

function SoapError(text) {
  return {
    Fault: {
      Code: {
        Value: "soap:Sender",
        Subcode: { value: "rpc:BadArguments" }
      },
      Reason: { Text: text },
      statusCode: 400
    }
  };
}

const idGenerator = (function* idGenerator() {
  'use strict';
  let id = ((db.last() || { id: 1 })).id;
  while (1) {
    yield ++id;
  }
})();


co(function* (){
  const warehouseService = yield thenify(soap.createClient)('http://andrei.xianet.com.ua/public/storage.php?r=item');
  const userService = yield thenify(soap.createClient)('https://microservice-users.herokuapp.com');
  const deliveryService = yield thenify(soap.createClient)('http://andrei.xianet.com.ua/public/delivering.php?r=ticket');

  function* getFullInfo(order) {
    'use strict';
    const products = __(order.products.id);
    const userId = __(order.userId);
    const productData = [];
    try {
      for (const id of products) {
        const response = yield thenify(warehouseService.getItemById)({ id });
        productData.push(response[0].return);
      };
    } catch (e) {
      throw new SoapError('Error while processing products');
    }

    return {
      products: {
        product: productData
      },
      id: order.id,
      userId,
      preferredAddress: order.preferredAddress
    };
  }

  const service = {
    'microservice.orders.OrdersControllerService': {
      'microservice.orders.OrdersControllerPort': {
        changeOrder: function (args, cb) {
          co(function* () {
            const id = +__(args.order.id);
            const order = db.find({ id });
            if (!order) {
              throw new SoapError('no such order');
            }
            Object.assign(order, __(args.order), { id });
            order.products.id = toArray(order.products.id).map(x => +__(x));
            order.userId = +__(order.userId);
            const info = yield getFullInfo(order);
            db.remove({ id });
            db.push(order);
            return info;
          }).then(cb, cb);

        },

        getOrderById: function (args, cb) {
          co(function* () {
            const id = +__(args.id);
            const order = db.find({ id });
            if (!order) {
              throw new SoapError('no such order');
            }
            return {
              return: yield getFullInfo(order)
            }
          }).then(cb, cb)
        },


        getOrdersByUserId: function (args,cb) {
          co(function* () {
            const id = +__(args.id);
            const ordersList = db.filter({ userId: id });
            const orders = [];
            for (var order of ordersList) {
              orders.push(yield getFullInfo(order));
            }

            return {
              'tns:orders': {
                order: orders
              }
            };
          }).then(cb, cb)
        },

        placeOrder: function (args, cb) {
          co(function* () {
            const order = __(args.order);
            order.id = idGenerator.next().value;
            order.products.id = toArray(order.products.id).map(x => +__(x));
            order.userId = +__(order.userId);
            const info = yield getFullInfo(order);
            yield thenify(deliveryService.addTicket)({
              address: order.preferredAddress,
              order_id: order.id,
              description: 'Retrieved from orders service'
            });
            db.push(order);
            return info;
          }).then(cb, cb);
        }
      }
    }

  };

  var xml = require('fs').readFileSync('orders.wsdl', 'utf8'),
  server = http.createServer(function(request,response) {
    response.setHeader('Content-Type', 'text/xml');
    response.end(xml);
  });

  var port = process.env.PORT || 3000;
  server.listen(port);
  soap.listen(server, '/orders', service, xml);
  console.log('launched at port ' + port);
}).catch(e => console.log(e));
