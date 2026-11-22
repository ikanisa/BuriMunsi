package rw.ikanisa.burimunsi.core

object BuriMunsiSupport {
    const val phone = "+250 788 767 816"
    val whatsappUrl = "https://wa.me/" + phone.filter(Char::isDigit)
}
