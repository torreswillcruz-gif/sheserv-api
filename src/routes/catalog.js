const catalogRouter = require("express").Router();
const { z } = require("zod");
const { runQuery } = require("../db");
const { ApiError, asyncHandler } = require("../errors");
const { isValidUuid } = require("../validation");

// ---------- Categorias ----------

catalogRouter.get("/categories", asyncHandler(async (request, response) => {
  const { parentId } = z.object({ parentId: z.string().optional() }).parse(request.query);

  const { rows: categories } = parentId
    ? await runQuery(
        'SELECT id, parent_id AS "parentId", name FROM categories WHERE parent_id=$1 ORDER BY name',
        [parentId]
      )
    : await runQuery(
        'SELECT id, parent_id AS "parentId", name FROM categories WHERE parent_id IS NULL ORDER BY name'
      );
  response.json(categories);
}));

// ---------- Prestadoras ----------

// Localização de quem busca (opcional): latitude e longitude vão sempre juntas
const locationQueryFields = {
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
};

function requireLatitudeAndLongitudeTogether(searchParams, validationContext) {
  if ((searchParams.latitude === undefined) !== (searchParams.longitude === undefined)) {
    validationContext.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["longitude"],
      message: "Send latitude and longitude together.",
    });
  }
}

const providerSearchSchema = z.object({
  ...locationQueryFields,
  categoryId: z.string().optional(),
  query: z.string().max(100).optional(),
  availableAt: z.string().datetime({ offset: true }).optional(),
  radiusKm: z.coerce.number().positive().max(500).optional(),
  serviceLocation: z.enum(["at_customer", "at_provider"]).optional(),
}).passthrough().superRefine((searchParams, validationContext) => {
  requireLatitudeAndLongitudeTogether(searchParams, validationContext);
  if (searchParams.radiusKm !== undefined && searchParams.latitude === undefined) {
    validationContext.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["radiusKm"],
      message: "radiusKm requires latitude and longitude.",
    });
  }
});

const providerDetailSchema = z.object(locationQueryFields)
  .passthrough()
  .superRefine(requireLatitudeAndLongitudeTogether);

// Distância em km (fórmula de Haversine) entre quem busca ($2, $3) e a base da prestadora.
// Fica NULL se faltar alguma coordenada (sem o CASE, o GREATEST/LEAST ignorariam os NULL).
const DISTANCE_IN_KM_SQL = `
  CASE
    WHEN $2::float8 IS NULL OR $3::float8 IS NULL
      OR provider_profile.latitude IS NULL OR provider_profile.longitude IS NULL
    THEN NULL
    ELSE 6371 * acos(LEAST(1, GREATEST(-1,
      cos(radians($2::float8)) * cos(radians(provider_profile.latitude))
        * cos(radians(provider_profile.longitude) - radians($3::float8))
      + sin(radians($2::float8)) * sin(radians(provider_profile.latitude))
    )))
  END`;

// O mapa de "atendimento na prestadora" mostra só uma área aproximada: as coordenadas são
// arredondadas para 2 casas (grade de ~1,1 km) e o círculo de 800 m sempre cobre o ponto real.
// O endereço exato só aparece no pedido, depois que a prestadora aceita.
const APPROXIMATE_AREA_RADIUS_METERS = 800;

// Parâmetros: $1 = categoryId, $2 = latitude, $3 = longitude
// Só devolvemos a distância, nunca as coordenadas exatas da prestadora (segurança).
const PROVIDER_SELECT_SQL = `
  SELECT
    provider_user.id,
    provider_user.name,
    provider_profile.bio,
    provider_profile.verified,
    provider_profile.activation_status AS "activationStatus",
    COALESCE(ratings.average_rating, 0)::float AS rating,
    COALESCE(ratings.review_count, 0)::int AS "reviewCount",
    ROUND((${DISTANCE_IN_KM_SQL})::numeric, 1)::float AS "distanceKm",
    CASE WHEN provider_venue.provider_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM services venue_service
           WHERE venue_service.provider_id = provider_user.id
             AND venue_service.active
             AND venue_service.service_location = 'at_provider')
      THEN json_build_object(
        'latitude', ROUND(provider_venue.latitude::numeric, 2)::float,
        'longitude', ROUND(provider_venue.longitude::numeric, 2)::float,
        'radiusMeters', ${APPROXIMATE_AREA_RADIUS_METERS},
        'neighborhood', provider_venue.neighborhood,
        'city', provider_venue.city
      )
    END AS "venueArea",
    COALESCE((
      SELECT json_agg(json_build_object(
        'id', listed_service.id,
        'categoryId', listed_service.category_id,
        'title', listed_service.title,
        'basePrice', listed_service.base_price::float,
        'durationMinutes', listed_service.duration_minutes,
        'serviceLocation', listed_service.service_location
      ))
      FROM services listed_service
      WHERE listed_service.provider_id = provider_user.id
        AND listed_service.active
        AND ($1::text IS NULL OR listed_service.category_id = $1::text)
    ), '[]') AS services
  FROM provider_profiles provider_profile
  JOIN users provider_user ON provider_user.id = provider_profile.user_id
  LEFT JOIN (
    SELECT target_id, avg(rating) AS average_rating, count(*) AS review_count
    FROM reviews
    WHERE direction = 'customer_to_provider'
    GROUP BY target_id
  ) ratings ON ratings.target_id = provider_user.id
  LEFT JOIN provider_venues provider_venue ON provider_venue.provider_id = provider_user.id`;

catalogRouter.get("/providers", asyncHandler(async (request, response) => {
  const searchParams = providerSearchSchema.parse(request.query);

  // Com localização, as mais próximas aparecem primeiro
  const orderByClause = searchParams.latitude !== undefined
    ? 'ORDER BY "distanceKm" ASC NULLS LAST, rating DESC, provider_user.name'
    : "ORDER BY rating DESC, provider_user.name";

  // Parâmetros: $1 categoryId, $2 latitude, $3 longitude, $4 texto, $5 availableAt, $6 radiusKm, $7 serviceLocation
  const { rows: providers } = await runQuery(
    `${PROVIDER_SELECT_SQL}
     WHERE provider_profile.activation_status = 'active'
       AND ($4::text IS NULL
            OR provider_user.name ILIKE '%' || $4::text || '%'
            OR EXISTS (SELECT 1 FROM services matching_service
                       WHERE matching_service.provider_id = provider_user.id
                         AND matching_service.active
                         AND matching_service.title ILIKE '%' || $4::text || '%'))
       AND ($1::text IS NULL
            OR EXISTS (SELECT 1 FROM services category_service
                       WHERE category_service.provider_id = provider_user.id
                         AND category_service.active
                         AND category_service.category_id = $1::text))
       AND ($5::timestamptz IS NULL
            OR NOT EXISTS (SELECT 1 FROM orders existing_order
                           WHERE existing_order.provider_id = provider_user.id
                             AND existing_order.status IN ('requested','accepted','on_the_way','in_progress')
                             AND $5::timestamptz < existing_order.scheduled_at + existing_order.duration_minutes * interval '1 minute'
                             AND $5::timestamptz + interval '1 minute' > existing_order.scheduled_at))
       AND ($6::float8 IS NULL OR (${DISTANCE_IN_KM_SQL}) <= $6::float8)
       AND ($7::text IS NULL
            OR EXISTS (SELECT 1 FROM services location_service
                       WHERE location_service.provider_id = provider_user.id
                         AND location_service.active
                         AND location_service.service_location = $7::text))
     ${orderByClause}
     LIMIT 50`,
    [
      searchParams.categoryId ?? null,
      searchParams.latitude ?? null,
      searchParams.longitude ?? null,
      searchParams.query ?? null,
      searchParams.availableAt ?? null,
      searchParams.radiusKm ?? null,
      searchParams.serviceLocation ?? null,
    ]
  );
  response.json(providers);
}));

catalogRouter.get("/providers/:id", asyncHandler(async (request, response) => {
  if (!isValidUuid(request.params.id)) throw new ApiError(404, "not_found", "Provider not found.");
  const searchParams = providerDetailSchema.parse(request.query);

  // Parâmetros: $1 categoryId (não usado aqui), $2 latitude, $3 longitude, $4 id da prestadora
  const { rows: matchingProviders } = await runQuery(
    `${PROVIDER_SELECT_SQL} WHERE provider_user.id = $4`,
    [null, searchParams.latitude ?? null, searchParams.longitude ?? null, request.params.id]
  );
  if (!matchingProviders[0]) throw new ApiError(404, "not_found", "Provider not found.");
  response.json(matchingProviders[0]);
}));

module.exports = catalogRouter;
