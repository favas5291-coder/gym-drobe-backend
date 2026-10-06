const express =
  require("express");

const {
  getAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
} =
  require(
    "../controllers/addressController"
  );

const {
  protect,
} =
  require(
    "../middleware/authMiddleware"
  );


const router =
  express.Router();


// Every address endpoint
// requires a valid JWT.

router.use(
  protect
);


router
  .route("/")
  .get(
    getAddresses
  )
  .post(
    createAddress
  );


router
  .route("/:id")
  .put(
    updateAddress
  )
  .delete(
    deleteAddress
  );


module.exports =
  router;